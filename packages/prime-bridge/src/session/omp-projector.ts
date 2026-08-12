import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type {
	SessionTreeImportEntry,
	SessionTreeImportNode,
	SessionTreeImportOptions,
	SessionTreeImportResult,
} from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { FileCas } from "./cas";
import { createLoss, type SessionLoss } from "./loss-ledger";
import { readOmpSession } from "./omp-reader";
import type { CanonicalToolPair, CasRef, JsonValue, SessionSpecNode, SessionSpecV1 } from "./spec";
import { validateSessionSpec } from "./spec";
import type { HistoricalToolResult, ToolMapOutput } from "./tool-map";
import { mapPrimeToolPair } from "./tool-map";

type OmpReopenOptions = { readonly trustedBridgeDigest: string };

export type OmpProjectImportOptions = SessionTreeImportOptions & {
	readonly cwd: string;
	readonly cas: FileCas;
	readonly importTree?: (
		cwd: string,
		nodes: readonly SessionTreeImportNode[],
		activeLeafId: string | null,
		options?: SessionTreeImportOptions,
	) => Promise<SessionTreeImportResult>;
	readonly openSession?: (path: string, options?: OmpReopenOptions) => Promise<unknown>;
};

export type OmpProjectionReport = {
	readonly nativeIdMap: SessionSpecV1["nativeIdMap"];
	readonly losses: readonly SessionLoss[];
	readonly activeLeafId: string | null;
	readonly bridgeDigest: string;
};

export type OmpProjectionResult = {
	readonly path: string;
	readonly report: OmpProjectionReport;
};

const casHash = /^[0-9a-f]{64}$/;
const blobRefPattern = /^blob:sha256:([0-9a-f]{64})$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCasRef(value: unknown): value is CasRef {
	return (
		isRecord(value) &&
		typeof value.hash === "string" &&
		casHash.test(value.hash) &&
		(value.byteLength === undefined ||
			(typeof value.byteLength === "number" && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0))
	);
}

function copyRef(ref: CasRef): CasRef {
	return ref.byteLength === undefined ? { hash: ref.hash } : { hash: ref.hash, byteLength: ref.byteLength };
}

function jsonText(value: JsonValue): string {
	const text = JSON.stringify(value);
	return text === undefined ? "null" : text;
}
function validTextImage(value: unknown): value is string | (TextContent | ImageContent)[] {
	if (typeof value === "string") return true;
	return (
		Array.isArray(value) &&
		value.every(
			block =>
				isRecord(block) &&
				((block.type === "text" && typeof block.text === "string") ||
					(block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")),
		)
	);
}

function validTextImageBlocks(value: unknown): value is (TextContent | ImageContent)[] {
	return Array.isArray(value) && validTextImage(value);
}

function contentForUser(node: SessionSpecNode, losses: SessionLoss[]): string | (TextContent | ImageContent)[] {
	if (validTextImage(node.content)) return structuredClone(node.content);
	losses.push(
		createLoss("entry_metadata_unrepresentable", "Content was serialized as text for OMP", node.id, node.role),
	);
	return jsonText(node.content);
}

function validToolCall(value: unknown): value is ToolCall {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function validThinking(value: unknown): value is ThinkingContent {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function validToolResult(value: unknown): value is ToolResultMessage {
	return (
		isRecord(value) &&
		value.role === "toolResult" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		Array.isArray(value.content) &&
		validTextImage(value.content) &&
		typeof value.isError === "boolean" &&
		typeof value.timestamp === "number"
	);
}

async function readJsonCas(cas: FileCas, ref: CasRef): Promise<unknown | undefined> {
	try {
		return JSON.parse(decoder.decode(await cas.read(ref)));
	} catch {
		return undefined;
	}
}

function timestamp(spec: SessionSpecV1): number {
	const value = Date.parse(spec.header.createdAt);
	return Number.isFinite(value) ? value : 0;
}

function deterministicLeafId(nodes: readonly SessionSpecNode[]): string | null {
	const byId = new Map(nodes.map(node => [node.id, node]));
	const originalOrder = new Map(nodes.map((node, index) => [node.id, index]));
	const depth = (node: SessionSpecNode): number => {
		let count = 0;
		let parentId = node.parentId;
		while (parentId !== null) {
			count++;
			parentId = byId.get(parentId)?.parentId ?? null;
		}
		return count;
	};
	const ordered = [...nodes].sort(
		(left, right) => depth(left) - depth(right) || originalOrder.get(left.id)! - originalOrder.get(right.id)!,
	);
	const parents = new Set(ordered.flatMap(node => (node.parentId === null ? [] : [node.parentId])));
	return [...ordered].reverse().find(node => !parents.has(node.id))?.id ?? null;
}

function collectDeclaredRefs(spec: SessionSpecV1): CasRef[] {
	const refs: CasRef[] = [];
	const add = (value: unknown): void => {
		if (isCasRef(value)) refs.push(value);
	};
	add(spec.header.sourceRef);
	for (const node of spec.nodes) {
		add(node.thinkingRef);
		add(node.providerPayloadRef);
		for (const value of Object.values(node.metadata ?? {})) add(value);
		for (const pair of node.toolPairs ?? []) {
			add(pair.originalCallRef);
			add(pair.synthesizedCallRef);
			add(pair.resultRef);
		}
	}
	return refs;
}

async function validateDeclaredRefs(spec: SessionSpecV1, cas: FileCas): Promise<void> {
	const seen = new Set<string>();
	for (const ref of collectDeclaredRefs(spec)) {
		const key = `${ref.hash}:${ref.byteLength ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		await cas.read(ref);
	}
}

function collectOmpBlobHashes(value: unknown, hashes: Set<string>, key?: string): void {
	const add = (candidate: unknown): void => {
		if (typeof candidate !== "string") return;
		const match = blobRefPattern.exec(candidate);
		if (match !== null) hashes.add(match[1]!);
	};
	if (Array.isArray(value)) {
		for (const item of value) collectOmpBlobHashes(item, hashes, key);
		return;
	}
	if (!isRecord(value)) return;
	const imagePayload =
		typeof value.data === "string" &&
		(value.type === "image" ||
			(typeof value.mimeType === "string" && value.mimeType.toLowerCase().startsWith("image/")));
	if (imagePayload && ((key === "content" && value.type === "image") || key === "images")) add(value.data);
	if (value.type === "image_generation_call") add(value.result);
	add(value.image_url);
	for (const [childKey, item] of Object.entries(value)) collectOmpBlobHashes(item, hashes, childKey);
}
function unavailableBlobHashes(losses: readonly SessionLoss[]): ReadonlySet<string> {
	const hashes = new Set<string>();
	for (const loss of losses) {
		if (loss.code !== "blob_unavailable" || loss.sourceType !== "blob") continue;
		const match = /^OMP blob is unavailable: ([0-9a-f]{64})$/.exec(loss.detail ?? "");
		if (match !== null) hashes.add(match[1]!);
	}
	return hashes;
}

function projectUnavailableBlobs(value: unknown, hashes: ReadonlySet<string>, key?: string): unknown {
	if (Array.isArray(value)) return value.map(item => projectUnavailableBlobs(item, hashes, key));
	if (!isRecord(value)) return value;
	const imagePayload =
		typeof value.data === "string" &&
		(value.type === "image" ||
			(typeof value.mimeType === "string" && value.mimeType.toLowerCase().startsWith("image/")));
	if (imagePayload && ((key === "content" && value.type === "image") || key === "images")) {
		const match = blobRefPattern.exec(value.data as string);
		if (match !== null && hashes.has(match[1]!)) return { type: "text", text: "[unavailable image blob]" };
	}
	const projected = Object.fromEntries(
		Object.entries(value).map(([childKey, child]) => {
			if (
				(childKey === "image_url" || (value.type === "image_generation_call" && childKey === "result")) &&
				typeof child === "string"
			) {
				const match = blobRefPattern.exec(child);
				if (match !== null && hashes.has(match[1]!)) return [childKey, "[unavailable image blob]"];
			}
			return [childKey, projectUnavailableBlobs(child, hashes, childKey)];
		}),
	);
	return projected;
}

function dedupeLosses(losses: readonly SessionLoss[]): SessionLoss[] {
	const seen = new Set<string>();
	return losses.filter(loss => {
		const key = JSON.stringify(loss);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
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
			const indexed = parent.toolPairs?.[pairIndex];
			if (indexed?.callId === pair.callId && indexed.toolName === pair.toolName)
				return { node: parent, pair: indexed };
			const matches = (parent.toolPairs ?? []).filter(
				candidate => candidate.callId === pair.callId && candidate.toolName === pair.toolName,
			);
			if (matches.length === 1) return { node: parent, pair: matches[0]! };
		}
		parentId = parent?.parentId ?? null;
	}
	return undefined;
}

async function prepareToolMappings(
	spec: SessionSpecV1,
	cas: FileCas,
	losses: SessionLoss[],
): Promise<{
	readonly mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>;
	readonly mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>;
}> {
	const byId = new Map(spec.nodes.map(node => [node.id, node]));
	const resultLinks = new WeakMap<
		CanonicalToolPair,
		{ readonly node: SessionSpecNode; readonly assistantPair: CanonicalToolPair }
	>();
	const firstResultForCall = new WeakMap<
		CanonicalToolPair,
		{ readonly node: SessionSpecNode; readonly pair: CanonicalToolPair }
	>();
	for (const node of spec.nodes) {
		if (node.role !== "toolResult") continue;
		for (const [pairIndex, pair] of (node.toolPairs ?? []).entries()) {
			const assistant = findAncestorAssistant(node, byId, pair, pairIndex);
			if (assistant === undefined) continue;
			resultLinks.set(pair, { node, assistantPair: assistant.pair });
			if (!firstResultForCall.has(assistant.pair)) firstResultForCall.set(assistant.pair, { node, pair });
		}
	}
	const exactCache = new Map<string, unknown | undefined>();
	const exactResult = async (ref: CasRef | undefined): Promise<unknown | undefined> => {
		if (ref === undefined) return undefined;
		const key = `${ref.hash}:${ref.byteLength ?? ""}`;
		if (!exactCache.has(key)) exactCache.set(key, await readJsonCas(cas, ref));
		return exactCache.get(key);
	};
	const historicalResult = async (
		node: SessionSpecNode | undefined,
		pair: CanonicalToolPair,
	): Promise<HistoricalToolResult> => {
		const exact = await exactResult(pair.resultRef);
		if (validToolResult(exact) && exact.toolCallId === pair.callId && exact.toolName === pair.toolName) {
			return {
				role: "toolResult",
				toolCallId: exact.toolCallId,
				toolName: exact.toolName,
				content: exact.content.map(
					(block): JsonValue =>
						block.type === "text"
							? { type: "text", text: block.text }
							: { type: "image", data: block.data, mimeType: block.mimeType },
				),
				isError: exact.isError,
			};
		}
		return {
			role: "toolResult",
			toolCallId: pair.callId,
			toolName: pair.toolName,
			content: node === undefined ? [] : Array.isArray(node.content) ? node.content : [node.content],
			isError: node?.metadata?.isError === true,
		};
	};
	const mappedCalls = new Map<CanonicalToolPair, ToolMapOutput>();
	for (const assistant of spec.nodes) {
		if (assistant.role !== "assistant") continue;
		for (const assistantPair of assistant.toolPairs ?? []) {
			if (assistantPair.toolName !== "ipython") continue;
			const matching = firstResultForCall.get(assistantPair);
			const pair = {
				...assistantPair,
				...(matching?.pair.resultRef === undefined ? {} : { resultRef: matching.pair.resultRef }),
			};
			const mapped = await mapPrimeToolPair({
				pair,
				result: await historicalResult(matching?.node, pair),
				cas,
			});
			mappedCalls.set(assistantPair, mapped);
			for (const loss of mapped.losses)
				losses.push(loss.nodeId === undefined ? { ...loss, nodeId: matching?.node.id ?? assistant.id } : loss);
		}
	}
	const mappedResults = new Map<CanonicalToolPair, ToolMapOutput>();
	for (const node of spec.nodes) {
		if (node.role !== "toolResult") continue;
		for (const pair of node.toolPairs ?? []) {
			const link = resultLinks.get(pair);
			if (link === undefined || link.assistantPair.toolName !== "ipython") continue;
			const mapPair = {
				...link.assistantPair,
				...(pair.resultRef === undefined ? {} : { resultRef: pair.resultRef }),
			};
			const mapped = await mapPrimeToolPair({
				pair: mapPair,
				result: await historicalResult(node, mapPair),
				cas,
			});
			mappedResults.set(pair, mapped);
			for (const loss of mapped.losses) losses.push(loss.nodeId === undefined ? { ...loss, nodeId: node.id } : loss);
		}
	}
	return { mappedCalls, mappedResults };
}

async function assistantEntry(
	node: SessionSpecNode,
	spec: SessionSpecV1,
	cas: FileCas,
	losses: SessionLoss[],
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
): Promise<SessionTreeImportEntry> {
	const content: AssistantMessage["content"] = [];
	if (Array.isArray(node.content)) {
		for (const block of node.content) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string")
				content.push({ type: "text", text: block.text });
			else if (validThinking(block)) {
				if (typeof block.thinkingSignature === "string" || typeof block.itemId === "string")
					losses.push(
						createLoss(
							"thinking_demoted",
							"Thinking provider signature was stripped because the OMP identity is historical",
							node.id,
							"thinking",
						),
					);
				content.push({ type: "thinking", thinking: block.thinking });
			} else if (validToolCall(block)) {
				const pair = node.toolPairs?.find(candidate => candidate.callId === block.id);
				const mapped = pair === undefined ? undefined : mappedCalls.get(pair);
				if (mapped !== undefined) content.push(structuredClone(mapped.call as unknown as ToolCall));
				else if (pair === undefined) content.push(structuredClone(block));
				else
					content.push({
						type: "toolCall",
						id: pair.callId,
						name: pair.toolName,
						arguments: isRecord(pair.argsSnapshot)
							? structuredClone(pair.argsSnapshot)
							: { value: pair.argsSnapshot },
					});
			} else {
				content.push({ type: "text", text: jsonText(block as JsonValue) });
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"Unsupported assistant content was serialized as text",
						node.id,
						"assistant",
					),
				);
			}
		}
	} else if (node.content !== "") {
		content.push({ type: "text", text: typeof node.content === "string" ? node.content : jsonText(node.content) });
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Non-array assistant content was serialized as text",
				node.id,
				"assistant",
			),
		);
	}
	for (const pair of node.toolPairs ?? []) {
		if (content.some(block => block.type === "toolCall" && block.id === pair.callId)) continue;
		let call: unknown;
		if (pair.originalCallRef !== undefined) call = await readJsonCas(cas, pair.originalCallRef);
		const mapped = mappedCalls.get(pair);
		if (mapped !== undefined) content.push(structuredClone(mapped.call as unknown as ToolCall));
		else if (!validToolCall(call)) {
			if (pair.originalCallRef !== undefined)
				losses.push(
					createLoss(
						"entry_metadata_unrepresentable",
						"Original tool call CAS payload was not a valid OMP tool call",
						node.id,
						"toolCall",
					),
				);
			content.push({
				type: "toolCall",
				id: pair.callId,
				name: pair.toolName,
				arguments: isRecord(pair.argsSnapshot) ? structuredClone(pair.argsSnapshot) : { value: pair.argsSnapshot },
			});
		} else content.push(structuredClone(call));
	}
	if (node.thinkingRef !== undefined && !content.some(block => block.type === "thinking")) {
		const thinking = await readJsonCas(cas, node.thinkingRef);
		if (validThinking(thinking)) {
			if (typeof thinking.thinkingSignature === "string" || typeof thinking.itemId === "string")
				losses.push(
					createLoss(
						"thinking_demoted",
						"Thinking provider signature was stripped because the OMP identity is historical",
						node.id,
						"thinking",
					),
				);
			content.push({ type: "thinking", thinking: thinking.thinking });
		} else
			losses.push(
				createLoss(
					"thinking_demoted",
					"Thinking CAS payload was not a valid OMP thinking block",
					node.id,
					"thinking",
				),
			);
	}
	if (node.providerPayloadRef !== undefined)
		losses.push(
			createLoss(
				"provider_payload_demoted",
				"Provider-native payload was stripped because the OMP identity is historical",
				node.id,
				"provider_payload",
			),
		);
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "historical",
		model: "historical",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: timestamp(spec),
	};
	return { type: "message", message };
}

async function resultEntry(
	node: SessionSpecNode,
	pair: CanonicalToolPair | undefined,
	cas: FileCas,
	spec: SessionSpecV1,
	losses: SessionLoss[],
	mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
): Promise<SessionTreeImportEntry> {
	const mapped = pair === undefined ? undefined : mappedResults.get(pair);
	if (mapped !== undefined)
		return {
			type: "message",
			message: { ...structuredClone(mapped.result), timestamp: timestamp(spec) } as ToolResultMessage,
		};
	let source: unknown;
	const ref = pair?.resultRef;
	if (ref !== undefined) source = await readJsonCas(cas, ref);
	const sourceResult =
		validToolResult(source) &&
		(pair === undefined || (source.toolCallId === pair.callId && source.toolName === pair.toolName))
			? source
			: undefined;
	if (ref !== undefined && sourceResult === undefined)
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Original tool result CAS payload was not a valid OMP tool result",
				node.id,
				"toolResult",
			),
		);
	if (sourceResult !== undefined) return { type: "message", message: structuredClone(sourceResult) };
	let content: ToolResultMessage["content"];
	if (validTextImageBlocks(node.content)) content = structuredClone(node.content);
	else if (typeof node.content === "string") content = [{ type: "text", text: node.content }];
	else {
		content = [{ type: "text", text: jsonText(node.content) }];
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Tool result content was serialized as text for OMP",
				node.id,
				"toolResult",
			),
		);
	}
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: pair?.callId ?? "historical-tool-call",
		toolName: pair?.toolName ?? "historical-tool",
		content,
		isError: node.metadata?.isError === true,
		timestamp: timestamp(spec),
	};
	return { type: "message", message };
}

async function convertNode(
	node: SessionSpecNode,
	spec: SessionSpecV1,
	cas: FileCas,
	losses: SessionLoss[],
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	resultPair?: CanonicalToolPair,
): Promise<SessionTreeImportEntry> {
	if (node.role === "assistant") return assistantEntry(node, spec, cas, losses, mappedCalls);
	if (node.role === "toolResult") return resultEntry(node, resultPair, cas, spec, losses, mappedResults);
	if (node.role === "compaction") {
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Compaction firstKeptEntryId and tokensBefore were not present in the canonical spec",
				node.id,
				"compaction",
			),
		);
		if (typeof node.content !== "string")
			losses.push(
				createLoss(
					"entry_metadata_unrepresentable",
					"Compaction content was serialized as text for OMP",
					node.id,
					"compaction",
				),
			);
		return {
			type: "compaction",
			summary: typeof node.content === "string" ? node.content : jsonText(node.content),
			firstKeptEntryId: node.parentId ?? node.id,
			tokensBefore: 0,
		};
	}
	if (node.role === "system" || node.role === "custom") {
		if (node.role === "system")
			losses.push(
				createLoss(
					"unsupported_role",
					"Canonical system role is represented as a hidden OMP custom message",
					node.id,
					"system",
				),
			);
		return {
			type: "custom_message",
			customType: node.role === "system" ? "omp/system" : "omp/custom",
			content: contentForUser(node, losses),
			display: false,
		};
	}
	return {
		type: "message",
		message: { role: "user", content: contentForUser(node, losses), timestamp: timestamp(spec) },
	};
}

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

function bridgeProvenance(
	nodes: readonly SessionSpecNode[],
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
): BridgeProvenance {
	const provenance = Object.create(null) as BridgeProvenance;
	for (const node of nodes) {
		const toolPairs = (node.toolPairs ?? []).map((pair, pairIndex) => {
			const mapped = node.role === "assistant" ? mappedCalls.get(pair) : mappedResults.get(pair);
			const synthesizedCallRef = mapped?.pair.synthesizedCallRef ?? pair.synthesizedCallRef;
			return {
				pairIndex,
				toolName: pair.toolName,
				callId: pair.callId,
				argsSnapshot: pair.argsSnapshot,
				...(pair.originalCallRef === undefined ? {} : { originalCallRef: copyRef(pair.originalCallRef) }),
				...(synthesizedCallRef === undefined ? {} : { synthesizedCallRef: copyRef(synthesizedCallRef) }),
				...(pair.resultRef === undefined ? {} : { resultRef: copyRef(pair.resultRef) }),
			};
		});
		const metadata = node.metadata;
		const sourceLineRef = metadata?.sourceLineRef;
		const sourceMessageRef = metadata?.sourceMessageRef;
		const titleSlotRef = metadata?.titleSlotRef;
		provenance[node.id] = {
			role: node.role,
			...(node.thinkingRef === undefined ? {} : { thinkingRef: copyRef(node.thinkingRef) }),
			...(node.providerPayloadRef === undefined ? {} : { providerPayloadRef: copyRef(node.providerPayloadRef) }),
			...(isCasRef(sourceLineRef) || isCasRef(sourceMessageRef) || isCasRef(titleSlotRef)
				? {
						metadata: {
							...(isCasRef(sourceLineRef) ? { sourceLineRef: copyRef(sourceLineRef) } : {}),
							...(isCasRef(sourceMessageRef) ? { sourceMessageRef: copyRef(sourceMessageRef) } : {}),
							...(isCasRef(titleSlotRef) ? { titleSlotRef: copyRef(titleSlotRef) } : {}),
						},
					}
				: {}),
			toolPairs,
		};
	}
	return provenance;
}

function bridgeDigest(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

function hasSameCanonicalTree(expected: SessionSpecV1, actual: SessionSpecV1): boolean {
	if (
		actual.nodes.length !== expected.nodes.length ||
		(expected.activeLeafId !== null && actual.activeLeafId !== expected.activeLeafId)
	)
		return false;
	const actualParents = new Map(actual.nodes.map(node => [node.id, node.parentId]));
	return expected.nodes.every(node => actualParents.get(node.id) === node.parentId);
}

function validateNativeProjection(
	spec: SessionSpecV1,
	activeLeafId: string,
	physicalNodes: readonly SessionTreeImportNode[],
	pairBySourceId: ReadonlyMap<string, CanonicalToolPair>,
	entries: readonly unknown[],
	map: Readonly<Record<string, string>>,
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
): void {
	const entriesById = new Map(entries.filter(isRecord).map(entry => [String(entry.id), entry]));
	for (const node of physicalNodes) {
		const nativeId = map[node.sourceId];
		const entry = nativeId === undefined ? undefined : entriesById.get(nativeId);
		const expectedParent = node.parentSourceId === null ? null : map[node.parentSourceId];
		const bridgeParent =
			node.sourceId === activeLeafId && node.parentSourceId === null && typeof entry?.parentId === "string"
				? entriesById.get(entry.parentId)
				: undefined;
		const parentMatches =
			entry?.parentId === expectedParent ||
			(bridgeParent?.type === "custom" && bridgeParent.customType === "prime-bridge/session-resume");
		if (entry === undefined || expectedParent === undefined || !parentMatches)
			throw new Error(`OMP imported session validation failed for ${node.sourceId}`);
		const pair = pairBySourceId.get(node.sourceId);
		if (pair !== undefined) {
			const message = isRecord(entry.message) ? entry.message : undefined;
			const mapped = mappedResults.get(pair);
			if (
				message?.role !== "toolResult" ||
				message.toolCallId !== (mapped?.result.toolCallId ?? pair.callId) ||
				message.toolName !== (mapped?.result.toolName ?? pair.toolName)
			)
				throw new Error(`OMP imported session validation failed for tool result ${node.sourceId}`);
		}
	}
	for (const node of spec.nodes) {
		if (node.role !== "assistant") continue;
		const entry = map[node.id] === undefined ? undefined : entriesById.get(map[node.id]!);
		const message = entry !== undefined && isRecord(entry.message) ? entry.message : undefined;
		const content = message?.role === "assistant" && Array.isArray(message.content) ? message.content : [];
		for (const pair of node.toolPairs ?? []) {
			const mapped = mappedCalls.get(pair);
			if (
				!content.some(
					value =>
						isRecord(value) &&
						value.type === "toolCall" &&
						value.id === (mapped?.call.id ?? pair.callId) &&
						value.name === (mapped?.call.name ?? pair.toolName),
				)
			)
				throw new Error(`OMP imported session validation failed for tool call ${node.id}:${pair.callId}`);
		}
	}
}

async function openAndValidate(
	path: string,
	spec: SessionSpecV1,
	nativeActiveLeafId: string,
	map: Record<string, string>,
	physicalNodes: readonly SessionTreeImportNode[],
	pairBySourceId: ReadonlyMap<string, CanonicalToolPair>,
	mappedCalls: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	mappedResults: ReadonlyMap<CanonicalToolPair, ToolMapOutput>,
	options: OmpProjectImportOptions,
	bridgeDigest: string,
): Promise<void> {
	const opened = options.openSession
		? await options.openSession(path, { trustedBridgeDigest: bridgeDigest })
		: await SessionManager.open(path, options.sessionDir, options.storage);
	if (!options.openSession) {
		try {
			const entries = (opened as SessionManager).getEntries();
			validateNativeProjection(
				spec,
				nativeActiveLeafId,
				physicalNodes,
				pairBySourceId,
				entries,
				map,
				mappedCalls,
				mappedResults,
			);
			const reopened = await readOmpSession(path, options.cas, { trustedBridgeDigest: bridgeDigest });
			if (!hasSameCanonicalTree(spec, reopened))
				throw new Error("OMP imported session validation failed: trusted canonical tree differs");
			return;
		} finally {
			await (opened as SessionManager).close();
		}
	}
	if (isRecord(opened) && opened.specVersion === 1) {
		const reopened = validateSessionSpec(opened);
		if (!hasSameCanonicalTree(spec, reopened))
			throw new Error("OMP imported session validation failed: canonical tree differs");
		return;
	}
	if (!isRecord(opened) || typeof opened.getEntries !== "function")
		throw new Error("OMP imported session validation failed: opener returned an unsupported shape");
	const entries = (opened.getEntries as () => readonly RecordValue[]).call(opened);
	if (!Array.isArray(entries)) throw new Error("OMP imported session validation failed: opener entries are invalid");
	validateNativeProjection(
		spec,
		nativeActiveLeafId,
		physicalNodes,
		pairBySourceId,
		entries,
		map,
		mappedCalls,
		mappedResults,
	);
	if (
		typeof opened.getLeafId === "function" &&
		(opened.getLeafId as () => string | null).call(opened) !== map[nativeActiveLeafId]
	)
		throw new Error("OMP imported session validation failed: active leaf differs");
}

export async function projectToOmp(
	specInput: SessionSpecV1,
	options: OmpProjectImportOptions,
): Promise<OmpProjectionResult> {
	if (typeof options.cwd !== "string" || options.cwd.length === 0) throw new Error("OMP projection requires cwd");
	if (options.cas === undefined) throw new Error("OMP projection requires cas");
	const spec = validateSessionSpec(specInput);
	await validateDeclaredRefs(spec, options.cas);
	const losses: SessionLoss[] = [...spec.lossLedger];
	for (const node of spec.nodes) {
		if (node.metadata?.titleSlotRef === undefined) continue;
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Exact OMP title-slot bytes cannot be reproduced by the public tree importer",
				node.id,
				"title",
			),
		);
	}
	losses.push(
		createLoss(
			"entry_metadata_unrepresentable",
			"OMP header field titleSource is not represented in SessionSpecHeader",
			undefined,
			"session",
		),
	);
	const nativeActiveLeafId = spec.activeLeafId ?? deterministicLeafId(spec.nodes);
	if (nativeActiveLeafId === null) throw new Error("OMP projection requires at least one canonical leaf");
	const { mappedCalls, mappedResults } = await prepareToolMappings(spec, options.cas, losses);
	const provenance = bridgeProvenance(spec.nodes, mappedCalls, mappedResults);
	const markerData = {
		version: 1,
		activeLeafId: spec.activeLeafId,
		header: spec.header.sourceRef === undefined ? {} : { sourceRef: copyRef(spec.header.sourceRef) },
		nativeIdMap: Object.create(null) as SessionSpecV1["nativeIdMap"],
		lossLedger: dedupeLosses(losses),
		provenance,
		tails: Object.create(null) as Record<string, readonly string[]>,
	};
	const marker = { customType: "prime-bridge/session-resume", data: markerData };
	const nodes: SessionTreeImportNode[] = [];
	const pairBySourceId = new Map<string, CanonicalToolPair>();
	const tailSourceIds = new Map<string, readonly string[]>();
	const usedSourceIds = new Set(spec.nodes.map(node => node.id));
	for (const node of spec.nodes) {
		if (node.role === "toolResult" && (node.toolPairs?.length ?? 0) > 1) {
			const pairs = node.toolPairs!;
			const tails: string[] = [];
			let parentSourceId = node.parentId;
			for (const [pairIndex, pair] of pairs.slice(0, -1).entries()) {
				const sourceId = `${node.id}.omp-tail-${pairIndex}`;
				if (usedSourceIds.has(sourceId)) throw new Error(`OMP synthetic tail source ID collides: ${sourceId}`);
				usedSourceIds.add(sourceId);
				nodes.push({
					sourceId,
					parentSourceId,
					entry: await convertNode(node, spec, options.cas, losses, mappedCalls, mappedResults, pair),
				});
				pairBySourceId.set(sourceId, pair);
				tails.push(sourceId);
				parentSourceId = sourceId;
			}
			tailSourceIds.set(node.id, tails);
			nodes.push({
				sourceId: node.id,
				parentSourceId,
				entry: await convertNode(
					node,
					spec,
					options.cas,
					losses,
					mappedCalls,
					mappedResults,
					pairs[pairs.length - 1],
				),
			});
			pairBySourceId.set(node.id, pairs[pairs.length - 1]!);
			continue;
		}
		const pairs = node.toolPairs ?? [];
		const pair = node.role === "toolResult" && pairs.length === 1 ? pairs[0] : undefined;
		nodes.push({
			sourceId: node.id,
			parentSourceId: node.parentId,
			entry: await convertNode(node, spec, options.cas, losses, mappedCalls, mappedResults, pair),
		});
		if (pair !== undefined) pairBySourceId.set(node.id, pair);
	}
	const unavailableHashes = unavailableBlobHashes(spec.lossLedger);
	const projectedNodes = nodes.map(node => ({
		...node,
		entry: projectUnavailableBlobs(node.entry, unavailableHashes) as SessionTreeImportEntry,
	}));
	const blobHashes = new Set<string>();
	for (const node of projectedNodes) collectOmpBlobHashes(node.entry, blobHashes);
	const blobs = await Promise.all([...blobHashes].map(async hash => ({ hash, bytes: await options.cas.read(hash) })));
	const importOptions: SessionTreeImportOptions = {
		...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
		...(options.storage === undefined ? {} : { storage: options.storage as never }),
		...(blobs.length === 0 ? {} : { blobs }),
		title: spec.header.title,
		validateBeforePublish: async (stagedPath, generatedIds) => {
			const bytes = new Uint8Array(await Bun.file(stagedPath).arrayBuffer());
			await openAndValidate(
				stagedPath,
				spec,
				nativeActiveLeafId,
				{ ...generatedIds },
				projectedNodes,
				pairBySourceId,
				mappedCalls,
				mappedResults,
				options,
				bridgeDigest(bytes),
			);
		},
		lossMarkerFactory: (generatedIds: Readonly<Record<string, string>>) => {
			for (const node of spec.nodes) {
				const nativeId = generatedIds[node.id];
				if (nativeId === undefined) throw new Error(`OMP importer generated no native ID for ${node.id}`);
				markerData.nativeIdMap[node.id] = {
					omp: nativeId,
					...(spec.nativeIdMap[node.id]?.prime === undefined ? {} : { prime: spec.nativeIdMap[node.id]!.prime }),
				};
			}
			for (const [nodeId, sourceIds] of tailSourceIds) {
				const nativeIds = sourceIds.map(sourceId => generatedIds[sourceId]);
				if (nativeIds.some(nativeId => nativeId === undefined))
					throw new Error(`OMP importer generated no native ID for synthetic tails of ${nodeId}`);
				markerData.tails[nodeId] = nativeIds as string[];
			}
			return marker;
		},
	};
	markerData.lossLedger = dedupeLosses(losses);
	const imported = options.importTree
		? await options.importTree(options.cwd, projectedNodes, nativeActiveLeafId, importOptions)
		: await SessionManager.importTree(options.cwd, projectedNodes, nativeActiveLeafId, importOptions);
	if (!isRecord(imported) || typeof imported.sessionPath !== "string" || !isRecord(imported.nativeIdMap))
		throw new Error("OMP importer returned an invalid result");
	const generatedIds: Record<string, string> = {};
	for (const node of nodes) {
		const nativeId = imported.nativeIdMap[node.sourceId];
		if (typeof nativeId !== "string" || nativeId.length === 0)
			throw new Error(`OMP importer returned no native ID for ${node.sourceId}`);
		generatedIds[node.sourceId] = nativeId;
	}
	const nativeIdMap: SessionSpecV1["nativeIdMap"] = {};
	for (const node of spec.nodes) {
		const nativeId = generatedIds[node.id]!;
		nativeIdMap[node.id] = {
			omp: nativeId,
			...(spec.nativeIdMap[node.id]?.prime === undefined ? {} : { prime: spec.nativeIdMap[node.id]!.prime }),
		};
		markerData.nativeIdMap[node.id] = { ...nativeIdMap[node.id] };
	}
	const bytes = new Uint8Array(await Bun.file(imported.sessionPath).arrayBuffer());
	const digest = bridgeDigest(bytes);
	return {
		path: imported.sessionPath,
		report: { nativeIdMap, losses: dedupeLosses(losses), activeLeafId: spec.activeLeafId, bridgeDigest: digest },
	};
}

export { readOmpSession };
