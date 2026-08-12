import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileCas } from "./cas";
import { createLoss, type SessionLoss } from "./loss-ledger";
import { readPrimeSession } from "./prime-reader";
import type { PrimeJsonObject } from "./prime-types";
import {
	type CanonicalToolPair,
	type CasRef,
	type JsonValue,
	type SessionSpecNode,
	type SessionSpecV1,
	validateSessionSpec,
} from "./spec";
import { mapOmpToolPair, type ToolMapOutput } from "./tool-map";

const BRIDGE_CUSTOM_TYPE = "prime-bridge/session-resume";
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);
function nativeIdMapsEqual(left: NativeIdMap, right: NativeIdMap): boolean {
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	for (const key of leftKeys) {
		const leftPair = left[key];
		const rightPair = right[key];
		if (
			leftPair === undefined ||
			rightPair === undefined ||
			leftPair.omp !== rightPair.omp ||
			leftPair.prime !== rightPair.prime
		)
			return false;
	}
	return true;
}
function casRefsEqual(
	left: { readonly hash: string; readonly byteLength?: number } | undefined,
	right: { readonly hash: string; readonly byteLength?: number } | undefined,
): boolean {
	return left === undefined
		? right === undefined
		: right !== undefined && left.hash === right.hash && left.byteLength === right.byteLength;
}

type NativeIdMap = SessionSpecV1["nativeIdMap"];
type BridgePairProvenance = {
	readonly pairIndex: number;
	readonly toolName: string;
	readonly callId: string;
	readonly argsSnapshot: JsonValue;
	readonly originalCallRef?: CasRef;
	readonly synthesizedCallRef?: CasRef;
	readonly resultRef?: CasRef;
};
type BridgeProvenance = Record<
	string,
	{
		readonly role: SessionSpecNode["role"];
		readonly thinkingRef?: CasRef;
		readonly providerPayloadRef?: CasRef;
		readonly metadata?: {
			readonly sourceLineRef?: CasRef;
			readonly sourceMessageRef?: CasRef;
			readonly titleSlotRef?: CasRef;
		};
		readonly toolPairs: readonly BridgePairProvenance[];
	}
>;

export type AtomicWriteRequest = {
	readonly tempPath: string;
	readonly bytes: Uint8Array;
};

export type ProjectToPrimeOptions = {
	readonly primeHome: string;
	readonly cas: FileCas;
	readonly sessionId?: string;
	readonly now?: (() => string) | string;
	readonly atomicWrite?: (request: AtomicWriteRequest) => Promise<void>;
	readonly syncDirectory?: (directory: string) => Promise<void>;
};

export type PrimeProjectionReport = {
	readonly nativeIdMap: NativeIdMap;
	readonly losses: readonly SessionLoss[];
	readonly activeLeafId: string | null;
	readonly bridgeDigest: string;
};

function dedupeLosses(losses: readonly SessionLoss[]): SessionLoss[] {
	const seen = new Set<string>();
	return losses.filter(loss => {
		const key = JSON.stringify(loss);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function primeId(canonicalId: string, used: Set<string>): string {
	for (let attempt = 0; attempt < 0x10000; attempt++) {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(attempt === 0 ? canonicalId : `${canonicalId}\u0000${attempt}`);
		const candidate = hasher.digest("hex").slice(0, 8);
		if (!used.has(candidate)) return candidate;
	}
	throw new Error("Unable to allocate a collision-safe Prime entry ID");
}

function timestampNumber(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

function jsonText(value: JsonValue): string {
	const text = JSON.stringify(value);
	return text === undefined ? "null" : text;
}

function bridgeDigest(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		return left.every((value, index) => jsonValuesEqual(value, right[index]!));
	}
	if (typeof left === "object" && typeof right === "object") {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		return leftKeys.every(
			key => hasOwn(right, key) && jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue),
		);
	}
	return false;
}

function isObject(value: JsonValue | undefined): value is PrimeJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function casRefFromValue(value: JsonValue | undefined): CasRef | undefined {
	if (!isObject(value) || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) return undefined;
	if (
		value.byteLength !== undefined &&
		(typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0)
	)
		return undefined;
	return { hash: value.hash, ...(value.byteLength === undefined ? {} : { byteLength: value.byteLength }) };
}

function copyCasRef(value: CasRef): CasRef {
	return { hash: value.hash, ...(value.byteLength === undefined ? {} : { byteLength: value.byteLength }) };
}

function declaredNodeMetadata(node: SessionSpecNode): BridgeProvenance[string]["metadata"] {
	const metadata = node.metadata;
	if (metadata === undefined) return undefined;
	const sourceLineRef = casRefFromValue(metadata.sourceLineRef);
	const sourceMessageRef = casRefFromValue(metadata.sourceMessageRef);
	const titleSlotRef = casRefFromValue(metadata.titleSlotRef);
	if (sourceLineRef === undefined && sourceMessageRef === undefined && titleSlotRef === undefined) return undefined;
	return {
		...(sourceLineRef === undefined ? {} : { sourceLineRef }),
		...(sourceMessageRef === undefined ? {} : { sourceMessageRef }),
		...(titleSlotRef === undefined ? {} : { titleSlotRef }),
	};
}
function primeCustomMetadata(node: SessionSpecNode, fallbackType: string): PrimeJsonObject {
	const metadata = node.metadata ?? {};
	return {
		customType: typeof metadata.customType === "string" ? metadata.customType : fallbackType,
		display: typeof metadata.display === "boolean" ? metadata.display : false,
		...(metadata.details === undefined ? {} : { details: metadata.details }),
	};
}
function metadataLosses(node: SessionSpecNode): SessionLoss[] {
	if (node.metadata === undefined) return [];
	const losses: SessionLoss[] = [];
	for (const [key, value] of Object.entries(node.metadata)) {
		const preservedReference =
			(key === "sourceLineRef" || key === "sourceMessageRef" || key === "titleSlotRef") &&
			casRefFromValue(value) !== undefined;
		const consumedIsError = key === "isError" && node.role === "toolResult" && typeof value === "boolean";
		const preservedCustom =
			(node.role === "custom" || node.role === "system") &&
			((key === "customType" && typeof value === "string") ||
				(key === "display" && typeof value === "boolean") ||
				key === "details");
		const preservedCompaction =
			node.role === "compaction" &&
			(key === "details" || key === "customInstructions" || (key === "fromHook" && typeof value === "boolean"));
		if (preservedReference || consumedIsError || preservedCustom || preservedCompaction) continue;
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				`Canonical node metadata field ${key} is not represented in Prime`,
				node.id,
				key,
			),
		);
	}
	return losses;
}

function textBlock(text: string): PrimeJsonObject {
	return { type: "text", text };
}

function isTextImageBlock(value: JsonValue): value is PrimeJsonObject {
	if (!isObject(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

function textImageContent(value: JsonValue): string | JsonValue[] {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(isTextImageBlock)) return value.map(block => ({ ...block }));
	return jsonText(value);
}
function assistantContent(
	node: SessionSpecNode,
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	losses: SessionLoss[],
): PrimeJsonObject[] {
	const result: PrimeJsonObject[] = [];
	let demotedThinking = false;
	if (Array.isArray(node.content)) {
		for (const block of node.content) {
			if (!isObject(block) || typeof block.type !== "string") {
				result.push(textBlock(jsonText(block)));
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"Assistant content block was serialized as text",
						node.id,
						"assistant",
					),
				);
				continue;
			}
			if (block.type === "text" && typeof block.text === "string") result.push({ ...block });
			else if (block.type === "thinking" && typeof block.thinking === "string") {
				result.push(textBlock(jsonText(block)));
				demotedThinking = true;
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"Assistant thinking content was serialized as text",
						node.id,
						"assistant",
					),
				);
			} else if (block.type !== "toolCall") {
				result.push(textBlock(jsonText(block)));
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						`Unsupported assistant content block: ${block.type}`,
						node.id,
						"assistant",
					),
				);
			}
		}
	} else if (node.content !== "") {
		result.push(textBlock(jsonText(node.content)));
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Non-empty assistant content was serialized as text",
				node.id,
				"assistant",
			),
		);
	}
	if (demotedThinking || node.thinkingRef !== undefined)
		losses.push(
			createLoss(
				"thinking_demoted",
				"Thinking payload is retained only in hidden bridge provenance",
				node.id,
				"thinking",
			),
		);
	for (const pair of node.toolPairs ?? []) {
		const mapped = mappedCalls.get(pair);
		if (mapped !== undefined) result.push(mapped.call as unknown as PrimeJsonObject);
	}
	return result;
}

function toolResultContent(
	node: SessionSpecNode,
	mapped: ToolMapOutput | undefined,
	losses: SessionLoss[],
): PrimeJsonObject[] {
	if (mapped !== undefined) return mapped.result.content as unknown as PrimeJsonObject[];
	const content = Array.isArray(node.content) ? node.content : [node.content];
	const filtered = content.filter(isTextImageBlock);
	if (filtered.length !== content.length)
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Tool result content contained unsupported blocks that were filtered",
				node.id,
				"toolResult",
			),
		);
	return filtered.map(block => ({ ...block }));
}

function findAncestorAssistant(
	node: SessionSpecNode,
	byId: ReadonlyMap<string, SessionSpecNode>,
	pair: CanonicalToolPair,
	pairIndex: number,
): { readonly node: SessionSpecNode; readonly pair: CanonicalToolPair } | undefined {
	let parentId = node.parentId;
	while (parentId !== null) {
		const parent = byId.get(parentId);
		if (parent?.role === "assistant") {
			const pairs = parent.toolPairs ?? [];
			const indexed = pairs[pairIndex];
			if (indexed?.callId === pair.callId && indexed.toolName === pair.toolName)
				return { node: parent, pair: indexed };
			const matches = pairs.filter(call => call.callId === pair.callId && call.toolName === pair.toolName);
			if (matches.length === 1) return { node: parent, pair: matches[0] };
		}
		parentId = parent?.parentId ?? null;
	}
	return undefined;
}

function bridgeProvenance(nodes: readonly SessionSpecNode[]): BridgeProvenance {
	const provenance = Object.create(null) as BridgeProvenance;
	for (const node of nodes) {
		const toolPairs = (node.toolPairs ?? []).map((pair, pairIndex) => ({
			pairIndex,
			toolName: pair.toolName,
			callId: pair.callId,
			argsSnapshot: pair.argsSnapshot,
			...(pair.originalCallRef === undefined ? {} : { originalCallRef: copyCasRef(pair.originalCallRef) }),
			...(pair.synthesizedCallRef === undefined ? {} : { synthesizedCallRef: copyCasRef(pair.synthesizedCallRef) }),
			...(pair.resultRef === undefined ? {} : { resultRef: copyCasRef(pair.resultRef) }),
		}));
		const metadata = declaredNodeMetadata(node);
		provenance[node.id] = {
			role: node.role,
			...(node.thinkingRef === undefined ? {} : { thinkingRef: copyCasRef(node.thinkingRef) }),
			...(node.providerPayloadRef === undefined ? {} : { providerPayloadRef: copyCasRef(node.providerPayloadRef) }),
			...(metadata === undefined ? {} : { metadata }),
			toolPairs,
		};
	}
	return provenance;
}
async function validateDeclaredRefs(spec: SessionSpecV1, cas: FileCas): Promise<void> {
	const references: CasRef[] = [];
	for (const node of spec.nodes) {
		if (node.thinkingRef !== undefined) references.push(node.thinkingRef);
		if (node.providerPayloadRef !== undefined) references.push(node.providerPayloadRef);
		const metadata = declaredNodeMetadata(node);
		if (metadata?.sourceLineRef !== undefined) references.push(metadata.sourceLineRef);
		if (metadata?.sourceMessageRef !== undefined) references.push(metadata.sourceMessageRef);
		if (metadata?.titleSlotRef !== undefined) references.push(metadata.titleSlotRef);
		for (const pair of node.toolPairs ?? [])
			for (const reference of [pair.originalCallRef, pair.synthesizedCallRef, pair.resultRef])
				if (reference !== undefined) references.push(reference);
	}
	for (const reference of references) await cas.read(reference);
}

async function writeDefault(request: AtomicWriteRequest): Promise<void> {
	const handle = await open(request.tempPath, "wx", 0o600);
	try {
		await handle.writeFile(request.bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectoryDefault(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function missingDirectoryChain(directory: string): Promise<string[]> {
	const missing: string[] = [];
	let current = directory;
	while (true) {
		try {
			await lstat(current);
			return missing;
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
			missing.push(current);
			const parent = dirname(current);
			if (parent === current) return missing;
			current = parent;
		}
	}
}

async function install(
	bytes: Uint8Array,
	finalPath: string,
	cas: FileCas,
	atomicWrite: ((request: AtomicWriteRequest) => Promise<void>) | undefined,
	syncDirectory: ((directory: string) => Promise<void>) | undefined,
	expected: {
		readonly nativeIdMap: NativeIdMap;
		readonly activeLeafId: string | null;
		readonly sourceRef?: CasRef;
		readonly bridgeDigest: string;
		readonly provenance: BridgeProvenance;
	},
): Promise<void> {
	const sessionDir = dirname(finalPath);
	let sessionDirStat: Stats;
	let newlyCreatedDirectories: string[] = [];
	try {
		sessionDirStat = await lstat(sessionDir);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		newlyCreatedDirectories = await missingDirectoryChain(sessionDir);
		await mkdir(sessionDir, { recursive: true });
		sessionDirStat = await lstat(sessionDir);
	}
	if (!sessionDirStat.isDirectory() || sessionDirStat.isSymbolicLink())
		throw new Error(`Prime sessions directory must be a real directory: ${sessionDir}`);
	let preexisting = false;
	try {
		await lstat(finalPath);
		preexisting = true;
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	if (preexisting) throw new Error(`Prime session already exists and will not be overwritten: ${finalPath}`);
	const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
	const sync = syncDirectory ?? syncDirectoryDefault;
	try {
		const request = { tempPath, bytes: bytes.slice() };
		if (atomicWrite === undefined) await writeDefault(request);
		else await atomicWrite(request);
		const parsed = await readPrimeSession(tempPath, cas, { trustedBridgeDigest: expected.bridgeDigest });
		if (
			parsed.activeLeafId !== expected.activeLeafId ||
			!nativeIdMapsEqual(parsed.nativeIdMap, expected.nativeIdMap) ||
			(expected.sourceRef !== undefined && !casRefsEqual(parsed.header.sourceRef, expected.sourceRef))
		)
			throw new Error(
				`Prime session validation did not restore bridge state: ${JSON.stringify({
					expectedActiveLeafId: expected.activeLeafId,
					actualActiveLeafId: parsed.activeLeafId,
					expectedNativeIdMap: expected.nativeIdMap,
					actualNativeIdMap: parsed.nativeIdMap,
				})}`,
			);
		for (const [nodeId, provenance] of Object.entries(expected.provenance)) {
			const node = parsed.nodes.find(candidate => candidate.id === nodeId);
			if (
				(provenance.thinkingRef !== undefined && !casRefsEqual(node?.thinkingRef, provenance.thinkingRef)) ||
				(provenance.providerPayloadRef !== undefined &&
					!casRefsEqual(node?.providerPayloadRef, provenance.providerPayloadRef)) ||
				(provenance.metadata?.sourceLineRef !== undefined &&
					!casRefsEqual(node?.metadata?.sourceLineRef as CasRef | undefined, provenance.metadata.sourceLineRef)) ||
				(provenance.metadata?.sourceMessageRef !== undefined &&
					!casRefsEqual(
						node?.metadata?.sourceMessageRef as CasRef | undefined,
						provenance.metadata.sourceMessageRef,
					)) ||
				(provenance.metadata?.titleSlotRef !== undefined &&
					!casRefsEqual(node?.metadata?.titleSlotRef as CasRef | undefined, provenance.metadata.titleSlotRef))
			)
				throw new Error(`Prime session validation did not restore node CAS provenance for ${nodeId}`);
			for (const expectedPair of provenance.toolPairs) {
				const actualPair = node?.toolPairs?.[expectedPair.pairIndex];
				if (
					actualPair === undefined ||
					actualPair.callId !== expectedPair.callId ||
					actualPair.toolName !== expectedPair.toolName ||
					!jsonValuesEqual(actualPair.argsSnapshot, expectedPair.argsSnapshot) ||
					(expectedPair.originalCallRef !== undefined &&
						!casRefsEqual(actualPair.originalCallRef, expectedPair.originalCallRef)) ||
					(expectedPair.synthesizedCallRef !== undefined &&
						!casRefsEqual(actualPair.synthesizedCallRef, expectedPair.synthesizedCallRef)) ||
					(expectedPair.resultRef !== undefined && !casRefsEqual(actualPair.resultRef, expectedPair.resultRef))
				)
					throw new Error(
						`Prime session validation did not restore CAS provenance for ${nodeId}:${expectedPair.callId}`,
					);
			}
		}
		for (const provenance of Object.values(expected.provenance)) {
			for (const ref of [provenance.thinkingRef, provenance.providerPayloadRef])
				if (ref !== undefined) await cas.read(ref);
			for (const ref of [
				provenance.metadata?.sourceLineRef,
				provenance.metadata?.sourceMessageRef,
				provenance.metadata?.titleSlotRef,
			])
				if (ref !== undefined) await cas.read(ref);
			for (const pair of provenance.toolPairs)
				for (const ref of [pair.originalCallRef, pair.synthesizedCallRef, pair.resultRef])
					if (ref !== undefined) await cas.read(ref);
		}
		if (expected.sourceRef !== undefined) await cas.read(expected.sourceRef);
		await link(tempPath, finalPath);
		await sync(sessionDir);
		for (const directory of new Set(newlyCreatedDirectories.map(directory => dirname(directory))))
			await sync(directory);
		await unlink(tempPath);
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			await unlink(tempPath);
		} catch (cleanupError) {
			if (
				typeof cleanupError !== "object" ||
				cleanupError === null ||
				!("code" in cleanupError) ||
				cleanupError.code !== "ENOENT"
			)
				cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0)
			throw new AggregateError([error, ...cleanupErrors], `Failed to publish and clean up output: ${finalPath}`);
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
			throw new Error(`Refusing to overwrite existing output: ${finalPath}`, { cause: error });
		throw error;
	}
}

export async function projectToPrime(
	source: SessionSpecV1,
	options: ProjectToPrimeOptions,
): Promise<{ readonly path: string; readonly report: PrimeProjectionReport }> {
	const spec = validateSessionSpec(source);
	const now = typeof options.now === "function" ? options.now() : (options.now ?? new Date().toISOString());
	await validateDeclaredRefs(spec, options.cas);
	const sessionId = options.sessionId ?? crypto.randomUUID();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId))
		throw new Error("Prime sessionId must be a lowercase UUID");
	const primePath = join(options.primeHome, "agent", "sessions", `${sessionId}.jsonl`);
	const byId = new Map(spec.nodes.map(node => [node.id, node]));
	const originalOrder = new Map(spec.nodes.map((node, index) => [node.id, index]));
	const depth = (node: SessionSpecNode): number => {
		let count = 0;
		let parent = node.parentId;
		while (parent !== null) {
			count++;
			parent = byId.get(parent)?.parentId ?? null;
		}
		return count;
	};
	const nodes = [...spec.nodes].sort(
		(left, right) => depth(left) - depth(right) || originalOrder.get(left.id)! - originalOrder.get(right.id)!,
	);
	const activeCanonicalId =
		spec.activeLeafId ??
		[...nodes].reverse().find(node => !nodes.some(candidate => candidate.parentId === node.id))?.id ??
		null;
	const orderedNodes =
		activeCanonicalId === null
			? nodes
			: [...nodes.filter(node => node.id !== activeCanonicalId), nodes.find(node => node.id === activeCanonicalId)!];
	const usedIds = new Set<string>();
	const nativeIdMap = Object.create(null) as NativeIdMap;
	for (const node of nodes) {
		const prime = primeId(node.id, usedIds);
		usedIds.add(prime);
		nativeIdMap[node.id] = {
			...(hasOwn(spec.nativeIdMap, node.id) ? spec.nativeIdMap[node.id] : {}),
			prime,
		};
	}
	const primeFor = (canonicalId: string): string => {
		if (!hasOwn(nativeIdMap, canonicalId)) throw new Error(`Missing Prime ID for ${canonicalId}`);
		const id = nativeIdMap[canonicalId]?.prime;
		if (id === undefined) throw new Error(`Missing Prime ID for ${canonicalId}`);
		return id;
	};
	const losses: SessionLoss[] = [...spec.lossLedger];
	losses.push(
		createLoss(
			"missing_source_bytes",
			"Prime v3 does not persist provider request/response payload bytes",
			undefined,
			"provider_payload",
		),
	);
	for (const node of nodes) losses.push(...metadataLosses(node));
	const mappedCalls = new Map<CanonicalToolPair, ToolMapOutput>();
	const mappedResults = new Map<CanonicalToolPair, ToolMapOutput>();
	const resultLinks = new WeakMap<
		CanonicalToolPair,
		{ readonly node: SessionSpecNode; readonly assistantPair: CanonicalToolPair }
	>();
	const firstResultForCall = new WeakMap<
		CanonicalToolPair,
		{ readonly node: SessionSpecNode; readonly pair: CanonicalToolPair }
	>();
	for (const node of nodes) {
		if (node.role !== "toolResult") continue;
		for (const [pairIndex, pair] of (node.toolPairs ?? []).entries()) {
			const assistant = findAncestorAssistant(node, byId, pair, pairIndex);
			if (assistant === undefined) continue;
			const link = { node, pair };
			resultLinks.set(pair, { node, assistantPair: assistant.pair });
			if (!firstResultForCall.has(assistant.pair)) firstResultForCall.set(assistant.pair, link);
		}
	}
	for (const assistant of nodes.filter(node => node.role === "assistant")) {
		for (const assistantPair of assistant.toolPairs ?? []) {
			const matching = firstResultForCall.get(assistantPair);
			const mapped = await mapOmpToolPair({
				pair: {
					...assistantPair,
					...(matching?.pair.resultRef === undefined ? {} : { resultRef: matching.pair.resultRef }),
				},
				result: {
					role: "toolResult",
					toolCallId: assistantPair.callId,
					toolName: assistantPair.toolName,
					content:
						matching === undefined
							? []
							: Array.isArray(matching.node.content)
								? matching.node.content
								: [matching.node.content],
					isError: matching?.node.metadata?.isError === true,
				},
				cas: options.cas,
			});
			mappedCalls.set(assistantPair, mapped);
			for (const loss of mapped.losses)
				losses.push(loss.nodeId === undefined ? { ...loss, nodeId: matching?.node.id ?? assistant.id } : loss);
		}
	}
	for (const node of nodes) {
		if (node.role !== "toolResult") continue;
		for (const pair of node.toolPairs ?? []) {
			const link = resultLinks.get(pair);
			if (link === undefined) continue;
			let isError = link.node.metadata?.isError === true;
			if (link.node.metadata?.isError === undefined && pair.resultRef !== undefined) {
				try {
					const persisted = JSON.parse(fatalDecoder.decode(await options.cas.read(pair.resultRef))) as JsonValue;
					if (isObject(persisted) && typeof persisted.isError === "boolean") isError = persisted.isError;
				} catch {
					losses.push(
						createLoss("blob_unavailable", "Tool result CAS payload was unavailable", link.node.id, "toolResult"),
					);
				}
			}
			const mapped = await mapOmpToolPair({
				pair: { ...link.assistantPair, ...(pair.resultRef === undefined ? {} : { resultRef: pair.resultRef }) },
				result: {
					role: "toolResult",
					toolCallId: pair.callId,
					toolName: pair.toolName,
					content: Array.isArray(node.content) ? node.content : [node.content],
					isError,
				},
				cas: options.cas,
			});
			mappedResults.set(pair, mapped);
			for (const loss of mapped.losses) losses.push(loss.nodeId === undefined ? { ...loss, nodeId: node.id } : loss);
		}
	}
	const timestamp = timestampNumber(now);
	const provenance = bridgeProvenance(spec.nodes);
	const entries: PrimeJsonObject[] = [];
	const tailIds = Object.create(null) as Record<string, string[]>;
	for (const node of orderedNodes) {
		const base = {
			id: primeFor(node.id),
			parentId: node.parentId === null ? null : primeFor(node.parentId),
			timestamp: now,
		};
		if (node.role === "compaction") {
			if (typeof node.content !== "string")
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"Non-string compaction content was serialized as text",
						node.id,
						"compaction",
					),
				);
			entries.push({
				type: "compaction",
				...base,
				firstKeptEntryId: base.parentId ?? base.id,
				summary: typeof node.content === "string" ? node.content : jsonText(node.content),
				tokensBefore: 0,
				...(node.metadata?.details === undefined ? {} : { details: node.metadata.details }),
				...(node.metadata?.fromHook === true ? { fromHook: true } : {}),
				...(typeof node.metadata?.customInstructions === "string"
					? { customInstructions: node.metadata.customInstructions }
					: {}),
			});
			continue;
		}
		if (node.role === "system" || node.role === "custom") {
			if (
				!(typeof node.content === "string" || (Array.isArray(node.content) && node.content.every(isTextImageBlock)))
			)
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"System or custom content was serialized as text",
						node.id,
						node.role,
					),
				);
			if (node.role === "system")
				losses.push(
					createLoss(
						"unsupported_role",
						"Canonical system role requires a hidden Prime bridge marker.",
						node.id,
						"system",
					),
				);
			entries.push({
				type: "custom_message",
				...base,
				...primeCustomMetadata(node, node.role === "system" ? "omp/system" : "omp/custom"),
				content: textImageContent(node.content),
			});
			continue;
		}
		if (node.role === "user") {
			if (
				!(typeof node.content === "string" || (Array.isArray(node.content) && node.content.every(isTextImageBlock)))
			)
				losses.push(
					createLoss("entry_metadata_unrepresentable", "User content was serialized as text", node.id, "user"),
				);
			entries.push({
				type: "message",
				...base,
				message: { role: "user", content: textImageContent(node.content), timestamp },
			});
			continue;
		}
		if (node.role === "assistant") {
			const content = assistantContent(node, mappedCalls, losses);
			if (node.providerPayloadRef !== undefined)
				losses.push(
					createLoss(
						"provider_payload_demoted",
						"Provider payload is not represented in Prime v3",
						node.id,
						"provider_payload",
					),
				);
			entries.push({
				type: "message",
				...base,
				message: {
					role: "assistant",
					content,
					api: "openai-completions",
					provider: "omp",
					model: "historical",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp,
				},
			});
			continue;
		}
		const pairs = node.toolPairs ?? [];
		let previousId = base.parentId;
		const nodeTailIds: string[] = [];
		for (const [index, pair] of pairs.entries()) {
			const isFinalPair = index === pairs.length - 1;
			const id = isFinalPair ? base.id : primeId(`${node.id}\u0000prime-tail\u0000${index}`, usedIds);
			if (!isFinalPair) {
				usedIds.add(id);
				nodeTailIds.push(id);
			}
			const mapped = mappedResults.get(pair);
			entries.push({
				type: "message",
				id,
				parentId: previousId,
				timestamp: now,
				message: {
					role: "toolResult",
					toolCallId: mapped?.result.toolCallId ?? pair.callId,
					toolName: mapped?.result.toolName ?? pair.toolName,
					content: toolResultContent(node, mapped, losses),
					isError: mapped?.result.isError ?? false,
					timestamp,
				},
			});
			previousId = id;
		}
		if (nodeTailIds.length > 0) tailIds[node.id] = nodeTailIds;
	}
	const selectedLeafId =
		spec.activeLeafId ??
		[...spec.nodes].reverse().find(node => !spec.nodes.some(candidate => candidate.parentId === node.id))?.id;
	if (selectedLeafId !== undefined) {
		const selectedPrimeId = primeFor(selectedLeafId);
		const selectedIndex = entries.findIndex(entry => entry.id === selectedPrimeId);
		if (selectedIndex >= 0) entries.push(...entries.splice(selectedIndex, 1));
	}
	const canonicalNativeIdMap = Object.create(null) as NativeIdMap;
	for (const node of spec.nodes) canonicalNativeIdMap[node.id] = { ...nativeIdMap[node.id]! };
	const canonicalProvenance = Object.create(null) as BridgeProvenance;
	for (const node of spec.nodes)
		if (provenance[node.id] !== undefined) canonicalProvenance[node.id] = provenance[node.id]!;
	const bridgeId = primeId("prime-bridge/session-resume", usedIds);
	const rootOnly = spec.nodes.length === 1 && entries.length === 1;
	const bridgeParent = rootOnly ? null : nodes.length > 0 ? primeFor(nodes[0]!.id) : null;
	const details = {
		version: 1,
		activeLeafId: spec.activeLeafId,
		header: spec.header.sourceRef === undefined ? {} : { sourceRef: copyCasRef(spec.header.sourceRef) },
		nativeIdMap: canonicalNativeIdMap,
		lossLedger: dedupeLosses(losses),
		provenance: canonicalProvenance,
		tails: tailIds,
	} as unknown as JsonValue;

	const bridgeEntry: PrimeJsonObject = {
		type: "custom_message",
		id: bridgeId,
		parentId: bridgeParent,
		timestamp: now,
		customType: BRIDGE_CUSTOM_TYPE,
		content: "",
		display: false,
		details,
	};
	if (rootOnly) {
		entries[0]!.parentId = bridgeId;
		entries.unshift(bridgeEntry);
	} else entries.splice(entries.length === 0 ? 0 : 1, 0, bridgeEntry);
	const header: PrimeJsonObject = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: now,
		cwd: spec.header.cwd,
	};
	const bytes = encoder.encode(`${[header, ...entries].map(record => JSON.stringify(record)).join("\n")}\n`);
	const snapshotDigest = bridgeDigest(bytes);
	await install(bytes, primePath, options.cas, options.atomicWrite, options.syncDirectory, {
		nativeIdMap: canonicalNativeIdMap,
		activeLeafId: spec.activeLeafId,
		sourceRef: spec.header.sourceRef,
		bridgeDigest: snapshotDigest,
		provenance: canonicalProvenance,
	});
	return {
		path: primePath,
		report: {
			nativeIdMap: canonicalNativeIdMap,
			losses: dedupeLosses(losses),
			activeLeafId: spec.activeLeafId,
			bridgeDigest: snapshotDigest,
		},
	};
}

export { BRIDGE_CUSTOM_TYPE };
