import { basename } from "node:path";
import type { FileCas } from "./cas";
import { createLoss, type SessionLoss, validateLossLedger } from "./loss-ledger";
import type { PrimeJsonObject, PrimeSessionHeader } from "./prime-types";
import {
	type CasRef,
	hasDuplicateJsonKeys,
	type JsonValue,
	type SessionSpecNode,
	type SessionSpecV1,
	validateSessionSpec,
} from "./spec";

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);
type MutableSessionNode = { -readonly [Key in keyof SessionSpecNode]: SessionSpecNode[Key] };

interface PhysicalLine {
	bytes: Uint8Array;
	text: string;
	value: PrimeJsonObject;
}
interface Span {
	start: number;
	end: number;
}

const KNOWN_ENTRY_TYPES: Record<string, true> = {
	message: true,
	model_change: true,
	thinking_level_change: true,
	service_tier_change: true,
	compaction: true,
	branch_summary: true,
	custom: true,
	custom_message: true,
	child_usage_attributed: true,
	label: true,
	session_info: true,
	session_state: true,
	agent_status: true,
	git_state: true,
};
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function bridgeDigest(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

async function putText(cas: FileCas, text: string): Promise<CasRef> {
	return cas.put(textEncoder.encode(text));
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isJsonValue(item));
	if (typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(item => isJsonValue(item));
}
function isJsonObject(value: unknown): value is PrimeJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}
function stringProperty(value: PrimeJsonObject, key: string): string | undefined {
	return typeof value[key] === "string" ? (value[key] as string) : undefined;
}
function requireString(value: PrimeJsonObject, key: string, context: string): string {
	const result = stringProperty(value, key);
	if (result === undefined) throw new Error(`${context} requires string field ${key}`);
	return result;
}
function requireNonEmptyString(value: PrimeJsonObject, key: string, context: string): string {
	const result = requireString(value, key, context);
	if (result.length === 0) throw new Error(`${context} requires non-empty string field ${key}`);
	return result;
}
function requireObject(value: PrimeJsonObject, key: string, context: string): PrimeJsonObject {
	const result = value[key];
	if (!isJsonObject(result)) throw new Error(`${context} requires object field ${key}`);
	return result;
}

function parsePhysicalLines(bytes: Uint8Array): PhysicalLine[] {
	const lines: PhysicalLine[] = [];
	let start = 0;
	for (let index = 0; index <= bytes.byteLength; index++) {
		if (index !== bytes.byteLength && bytes[index] !== 0x0a) continue;
		let end = index;
		if (end > start && bytes[end - 1] === 0x0d) end -= 1;
		const lineBytes = bytes.slice(start, end);
		const text = textDecoder.decode(lineBytes);
		start = index + 1;
		if (text.trim().length === 0) continue;
		let value: unknown;
		if (hasDuplicateJsonKeys(text)) throw new Error("Prime session contains duplicate JSON object keys");
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error("Prime session contains malformed JSONL");
		}
		if (!isJsonObject(value)) throw new Error("Prime session JSONL entries must be objects");
		lines.push({ bytes: lineBytes, text, value });
	}
	return lines;
}
function stringEnd(text: string, start: number): number | undefined {
	if (text[start] !== '"') return undefined;
	let escaped = false;
	for (let index = start + 1; index < text.length; index++) {
		const character = text[index];
		if (escaped) escaped = false;
		else if (character === "\\") escaped = true;
		else if (character === '"') return index + 1;
	}
	return undefined;
}
function valueEnd(text: string, start: number): number | undefined {
	let index = start;
	while (/\s/.test(text[index] ?? "")) index++;
	if (text[index] === '"') return stringEnd(text, index);
	if (text[index] !== "{" && text[index] !== "[") {
		while (index < text.length && !",]}\n\r".includes(text[index] ?? "")) index++;
		return index;
	}
	const closing: string[] = [text[index] === "{" ? "}" : "]"];
	let inString = false;
	let escaped = false;
	for (index += 1; index < text.length && closing.length > 0; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
		} else if (character === '"') inString = true;
		else if (character === "{" || character === "[") closing.push(character === "{" ? "}" : "]");
		else if (character === closing[closing.length - 1]) closing.pop();
	}
	return closing.length === 0 ? index : undefined;
}
function propertySpan(text: string, property: string): Span | undefined {
	let index = 0;
	while (/\s/.test(text[index] ?? "")) index++;
	if (text[index] !== "{") return undefined;
	for (index += 1; index < text.length; ) {
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === "}") return undefined;
		const keyEnd = stringEnd(text, index);
		if (keyEnd === undefined) return undefined;
		let key: unknown;
		try {
			key = JSON.parse(text.slice(index, keyEnd));
		} catch {
			return undefined;
		}
		index = keyEnd;
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] !== ":") return undefined;
		index++;
		while (/\s/.test(text[index] ?? "")) index++;
		const start = index;
		const end = valueEnd(text, start);
		if (end === undefined) return undefined;
		if (key === property) return { start, end };
		index = end;
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === ",") index++;
		else if (text[index] === "}") return undefined;
	}
	return undefined;
}
function arraySpans(text: string, span: Span): Span[] {
	const result: Span[] = [];
	let index = span.start;
	while (/\s/.test(text[index] ?? "")) index++;
	if (text[index] !== "[") return result;
	for (index += 1; index < span.end; ) {
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === "]") break;
		const start = index;
		const end = valueEnd(text, start);
		if (end === undefined || end > span.end) break;
		result.push({ start, end });
		index = end;
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === ",") index++;
		else if (text[index] !== "]") break;
	}
	return result;
}

function validateHeader(value: PrimeJsonObject): PrimeSessionHeader {
	if (
		value.type !== "session" ||
		value.version !== 3 ||
		typeof value.id !== "string" ||
		typeof value.timestamp !== "string" ||
		typeof value.cwd !== "string"
	) {
		throw new Error("Prime session must begin with a version 3 session header");
	}
	if (value.parentSession !== undefined && typeof value.parentSession !== "string")
		throw new Error("Prime session header parentSession must be a string");
	if (
		value.rlmDepth !== undefined &&
		(typeof value.rlmDepth !== "number" || !Number.isSafeInteger(value.rlmDepth) || value.rlmDepth < 0)
	)
		throw new Error("Prime session header rlmDepth must be a non-negative integer");
	if (value.git !== undefined) {
		const git = requireObject(value, "git", "Prime session header");
		for (const key of ["repoUrl", "commit", "branch"] as const)
			if (git[key] !== undefined && typeof git[key] !== "string")
				throw new Error(`Prime session header git.${key} must be a string`);
	}
	return {
		type: "session",
		version: 3,
		id: value.id,
		timestamp: value.timestamp,
		cwd: value.cwd,
		...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}),
		...(typeof value.rlmDepth === "number" ? { rlmDepth: value.rlmDepth } : {}),
		...(isJsonObject(value.git) ? { git: value.git } : {}),
	};
}
function validateEntryShape(entry: PrimeJsonObject): void {
	if (
		typeof entry.type !== "string" ||
		typeof entry.id !== "string" ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		typeof entry.timestamp !== "string"
	)
		throw new Error("Prime session entry is missing a valid type, id, parentId, or timestamp");
}
function requireFiniteNumber(value: PrimeJsonObject, key: string, context: string): number {
	const result = value[key];
	if (typeof result !== "number" || !Number.isFinite(result))
		throw new Error(`${context} requires finite number field ${key}`);
	return result;
}
function validateOptional(
	value: PrimeJsonObject,
	key: string,
	predicate: (value: JsonValue) => boolean,
	context: string,
): void {
	if (value[key] !== undefined && !predicate(value[key]))
		throw new Error(`${context} has invalid optional field ${key}`);
}
function validateTextImageContent(value: JsonValue | undefined, context: string): void {
	if (typeof value === "string") return;
	if (!Array.isArray(value)) throw new Error(`${context} content must be a string or array`);
	for (const [index, block] of value.entries()) {
		const blockContext = `${context} content block ${index}`;
		if (!isJsonObject(block) || typeof block.type !== "string") throw new Error(`${blockContext} is invalid`);
		if (block.type === "text") {
			requireString(block, "text", blockContext);
			validateOptional(block, "textSignature", value => typeof value === "string", blockContext);
		} else if (block.type === "image") {
			requireString(block, "data", blockContext);
			requireString(block, "mimeType", blockContext);
		} else throw new Error(`${blockContext} has unsupported type ${block.type}`);
	}
}
function validateAssistantContent(value: JsonValue | undefined, context: string): void {
	if (!Array.isArray(value)) throw new Error(`${context} content must be an array`);
	for (const [index, block] of value.entries()) {
		const blockContext = `${context} content block ${index}`;
		if (!isJsonObject(block) || typeof block.type !== "string") throw new Error(`${blockContext} is invalid`);
		if (block.type === "text") {
			requireString(block, "text", blockContext);
			validateOptional(block, "textSignature", value => typeof value === "string", blockContext);
		} else if (block.type === "thinking") {
			requireString(block, "thinking", blockContext);
			validateOptional(block, "thinkingSignature", value => typeof value === "string", blockContext);
			validateOptional(block, "redacted", value => typeof value === "boolean", blockContext);
		} else if (block.type === "toolCall") {
			requireNonEmptyString(block, "id", blockContext);
			requireNonEmptyString(block, "name", blockContext);
			requireObject(block, "arguments", blockContext);
			validateOptional(block, "thoughtSignature", value => typeof value === "string", blockContext);
		} else throw new Error(`${blockContext} has unsupported type ${block.type}`);
	}
}
function validateUsage(value: PrimeJsonObject, context: string): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		requireFiniteNumber(value, key, context);
	const cost = requireObject(value, "cost", context);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		requireFiniteNumber(cost, key, `${context}.cost`);
}
function validateDiagnostics(value: JsonValue | undefined, context: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error(`${context} diagnostics must be an array`);
	for (const [index, item] of value.entries()) {
		const diagnosticContext = `${context} diagnostics[${index}]`;
		if (!isJsonObject(item)) throw new Error(`${diagnosticContext} must be an object`);
		requireString(item, "type", diagnosticContext);
		requireFiniteNumber(item, "timestamp", diagnosticContext);
		if (item.error !== undefined) {
			const error = requireObject(item, "error", diagnosticContext);
			requireString(error, "message", `${diagnosticContext}.error`);
			validateOptional(error, "name", value => typeof value === "string", `${diagnosticContext}.error`);
			validateOptional(error, "stack", value => typeof value === "string", `${diagnosticContext}.error`);
			validateOptional(
				error,
				"code",
				value => typeof value === "string" || typeof value === "number",
				`${diagnosticContext}.error`,
			);
		}
		validateOptional(item, "details", isJsonObject, diagnosticContext);
	}
}
function validateMessage(message: PrimeJsonObject, context: string): void {
	const role = requireString(message, "role", context);
	requireFiniteNumber(message, "timestamp", context);
	if (role === "user") {
		validateTextImageContent(message.content, context);
		return;
	}
	if (role === "assistant") {
		requireString(message, "api", context);
		requireString(message, "provider", context);
		requireString(message, "model", context);
		validateAssistantContent(message.content, context);
		validateUsage(requireObject(message, "usage", context), `${context}.usage`);
		const stopReason = requireString(message, "stopReason", context);
		if (!["stop", "length", "toolUse", "error", "aborted"].includes(stopReason))
			throw new Error(`${context} has invalid stopReason`);
		for (const key of ["responseModel", "responseId", "errorMessage", "stopReasonRaw"] as const)
			validateOptional(message, key, value => typeof value === "string", context);
		validateDiagnostics(message.diagnostics, context);
		return;
	}
	if (role === "toolResult") {
		requireNonEmptyString(message, "toolCallId", context);
		requireNonEmptyString(message, "toolName", context);
		if (!Array.isArray(message.content)) throw new Error(`${context} toolResult content must be an array`);
		for (const [index, block] of message.content.entries()) {
			const blockContext = `${context} content block ${index}`;
			if (!isJsonObject(block) || (block.type !== "text" && block.type !== "image"))
				throw new Error(`${blockContext} is invalid`);
			if (block.type === "text") {
				requireString(block, "text", blockContext);
				validateOptional(block, "textSignature", value => typeof value === "string", blockContext);
			} else {
				requireString(block, "data", blockContext);
				requireString(block, "mimeType", blockContext);
			}
		}
		validateOptional(message, "details", isJsonValue, context);
		if (typeof message.isError !== "boolean") throw new Error(`${context} toolResult isError must be boolean`);
		return;
	}
	if (role === "bashExecution") {
		requireString(message, "command", context);
		requireString(message, "output", context);
		validateOptional(message, "exitCode", value => typeof value === "number" && Number.isInteger(value), context);
		validateOptional(message, "fullOutputPath", value => typeof value === "string", context);
		validateOptional(message, "excludeFromContext", value => typeof value === "boolean", context);
		if (typeof message.cancelled !== "boolean" || typeof message.truncated !== "boolean")
			throw new Error(`${context} bashExecution flags must be boolean`);
		return;
	}
	if (role === "custom") {
		requireString(message, "customType", context);
		validateTextImageContent(message.content, context);
		if (typeof message.display !== "boolean") throw new Error(`${context} custom display must be boolean`);
		validateOptional(message, "details", isJsonValue, context);
		return;
	}
	if (role === "branchSummary") {
		requireString(message, "summary", context);
		requireString(message, "fromId", context);
		return;
	}
	if (role === "compactionSummary") {
		requireString(message, "summary", context);
		requireFiniteNumber(message, "tokensBefore", context);
		validateOptional(
			message,
			"retainedMessageCount",
			value => typeof value === "number" && Number.isInteger(value) && value >= 0,
			context,
		);
		validateOptional(message, "customInstructions", value => typeof value === "string", context);
		return;
	}
	throw new Error(`${context} has unsupported message role ${role}`);
}
function validateServiceTier(value: JsonValue | undefined, context: string): void {
	if (
		value !== null &&
		value !== undefined &&
		(typeof value !== "string" || !["auto", "default", "flex", "scale", "priority"].includes(value))
	)
		throw new Error(`${context} has invalid serviceTier`);
}
function validateGitObject(value: PrimeJsonObject, context: string): void {
	for (const key of ["repoUrl", "commit", "branch"] as const)
		validateOptional(value, key, item => typeof item === "string", context);
}
function validateSessionState(value: PrimeJsonObject, context: string): void {
	const status = requireString(value, "status", context);
	if (!["active", "archived", "crash"].includes(status)) throw new Error(`${context} has invalid status`);
}
function validateAgentStatus(value: PrimeJsonObject, context: string): void {
	requireString(value, "summary", context);
	const basedOnMessageCount = requireFiniteNumber(value, "basedOnMessageCount", context);
	if (!Number.isInteger(basedOnMessageCount) || basedOnMessageCount < 0)
		throw new Error(`${context} basedOnMessageCount must be a non-negative integer`);
	validateOptional(value, "taskState", item => item === "needs_input" || item === "completed", context);
}
function validateKnownEntry(entry: PrimeJsonObject): void {
	const context = `Prime ${String(entry.type)} entry ${String(entry.id)}`;
	switch (entry.type) {
		case "message":
			validateMessage(requireObject(entry, "message", context), context);
			return;
		case "model_change":
			requireString(entry, "provider", context);
			requireString(entry, "modelId", context);
			return;
		case "thinking_level_change":
			requireString(entry, "thinkingLevel", context);
			return;
		case "service_tier_change":
			if (entry.serviceTier === undefined) throw new Error(`${context} requires serviceTier`);
			validateServiceTier(entry.serviceTier, context);
			return;
		case "compaction":
			requireString(entry, "summary", context);
			requireString(entry, "firstKeptEntryId", context);
			requireFiniteNumber(entry, "tokensBefore", context);
			validateOptional(entry, "details", isJsonValue, context);
			validateOptional(entry, "fromHook", value => typeof value === "boolean", context);
			validateOptional(entry, "customInstructions", value => typeof value === "string", context);
			return;
		case "branch_summary":
			requireString(entry, "fromId", context);
			requireString(entry, "summary", context);
			validateOptional(entry, "details", isJsonValue, context);
			validateOptional(entry, "fromHook", value => typeof value === "boolean", context);
			return;
		case "custom":
			requireString(entry, "customType", context);
			validateOptional(entry, "data", isJsonValue, context);
			return;
		case "custom_message":
			requireString(entry, "customType", context);
			validateTextImageContent(entry.content, context);
			if (typeof entry.display !== "boolean") throw new Error(`${context} display must be boolean`);
			validateOptional(entry, "details", isJsonValue, context);
			return;
		case "child_usage_attributed": {
			requireString(entry, "targetId", context);
			validateUsage(requireObject(entry, "childUsage", context), `${context}.childUsage`);
			validateUsage(requireObject(entry, "aggregateUsage", context), `${context}.aggregateUsage`);
			validateOptional(
				entry,
				"origin",
				value => value === "spawn_task" || value === "agent_message" || value === "direct_user",
				context,
			);
			return;
		}
		case "label":
			requireString(entry, "targetId", context);
			validateOptional(entry, "label", value => typeof value === "string", context);
			return;
		case "session_info":
			validateOptional(entry, "name", value => typeof value === "string", context);
			return;
		case "session_state":
			validateSessionState(requireObject(entry, "state", context), `${context}.state`);
			return;
		case "agent_status":
			validateAgentStatus(requireObject(entry, "status", context), `${context}.status`);
			return;
		case "git_state":
			validateGitObject(requireObject(entry, "git", context), `${context}.git`);
			return;
		default:
			return;
	}
}
function validatePhysicalTree(entries: readonly PrimeJsonObject[]): void {
	if (entries.length === 0) return;
	const allIds = new Set(entries.map(entry => String(entry.id)));
	const seen = new Set<string>();
	let roots = 0;
	for (const [index, entry] of entries.entries()) {
		const id = String(entry.id);
		const parentId = entry.parentId === null ? null : String(entry.parentId);
		if (seen.has(id)) throw new Error(`Prime session contains duplicate entry id ${id}`);
		if (parentId === null) {
			roots++;
			if (index !== 0) throw new Error("Prime session must contain exactly one root entry");
		} else if (!seen.has(parentId)) {
			const later = entries.findIndex(candidate => candidate.id === parentId);
			if (later >= 0 && entries[later]?.parentId === id) throw new Error("Prime session contains a cycle");
			if (!allIds.has(parentId)) throw new Error(`Prime session entry ${id} has a missing parent`);
			throw new Error(`Prime session entry ${id} has a forward parent`);
		}
		seen.add(id);
	}
	if (roots !== 1) throw new Error("Prime session must contain exactly one root entry");
}
const BRIDGE_CUSTOM_TYPE = "prime-bridge/session-resume";
const CANONICAL_ROLES: Readonly<Record<SessionSpecNode["role"], true>> = {
	user: true,
	assistant: true,
	toolResult: true,
	system: true,
	custom: true,
	compaction: true,
};
type BridgePairProvenance = {
	readonly pairIndex: number;
	readonly toolName: string;
	readonly callId: string;
	readonly argsSnapshot: JsonValue;
	readonly originalCallRef?: CasRef;
	readonly synthesizedCallRef?: CasRef;
	readonly resultRef?: CasRef;
};
type BridgeDetails = {
	readonly activeLeafId: string | null;
	readonly header: { readonly sourceRef?: CasRef };
	readonly nativeIdMap: SessionSpecV1["nativeIdMap"];
	readonly lossLedger: SessionLoss[];
	readonly provenance: Record<
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
	readonly tails: Record<string, readonly string[]>;
};

function bridgeCasRef(value: JsonValue | undefined): CasRef | undefined {
	if (!isJsonObject(value) || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) return undefined;
	if (
		value.byteLength !== undefined &&
		(typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0)
	)
		return undefined;
	return { hash: value.hash, ...(value.byteLength === undefined ? {} : { byteLength: value.byteLength }) };
}
function parseBridgeDetails(value: JsonValue | undefined): BridgeDetails | undefined {
	if (
		!isJsonObject(value) ||
		value.version !== 1 ||
		(typeof value.activeLeafId !== "string" && value.activeLeafId !== null)
	)
		return undefined;
	if (!isJsonObject(value.nativeIdMap) || !isJsonObject(value.provenance)) return undefined;
	const headerValue = value.header;
	const sourceRef =
		headerValue === undefined
			? undefined
			: !isJsonObject(headerValue)
				? undefined
				: headerValue.sourceRef === undefined
					? undefined
					: bridgeCasRef(headerValue.sourceRef);
	if (
		headerValue !== undefined &&
		(!isJsonObject(headerValue) || (headerValue.sourceRef !== undefined && sourceRef === undefined))
	)
		return undefined;
	const nativeIdMap = Object.create(null) as SessionSpecV1["nativeIdMap"];
	for (const [canonicalId, pairValue] of Object.entries(value.nativeIdMap)) {
		if (
			!isJsonObject(pairValue) ||
			typeof pairValue.prime !== "string" ||
			!/^[0-9a-f]{8}$/.test(pairValue.prime) ||
			(pairValue.omp !== undefined && typeof pairValue.omp !== "string")
		)
			return undefined;
		nativeIdMap[canonicalId] = {
			prime: pairValue.prime,
			...(pairValue.omp === undefined ? {} : { omp: pairValue.omp }),
		};
	}
	let lossLedger: SessionLoss[];
	try {
		lossLedger = validateLossLedger(value.lossLedger);
	} catch {
		return undefined;
	}
	const provenance = Object.create(null) as BridgeDetails["provenance"];
	for (const [nodeId, provenanceValue] of Object.entries(value.provenance)) {
		if (
			!isJsonObject(provenanceValue) ||
			!Array.isArray(provenanceValue.toolPairs) ||
			typeof provenanceValue.role !== "string" ||
			!hasOwn(CANONICAL_ROLES, provenanceValue.role)
		)
			return undefined;
		const role = provenanceValue.role as SessionSpecNode["role"];
		const thinkingRef =
			provenanceValue.thinkingRef === undefined ? undefined : bridgeCasRef(provenanceValue.thinkingRef);
		const providerPayloadRef =
			provenanceValue.providerPayloadRef === undefined
				? undefined
				: bridgeCasRef(provenanceValue.providerPayloadRef);
		if (
			(provenanceValue.thinkingRef !== undefined && thinkingRef === undefined) ||
			(provenanceValue.providerPayloadRef !== undefined && providerPayloadRef === undefined)
		)
			return undefined;
		let metadata: BridgeDetails["provenance"][string]["metadata"];
		if (provenanceValue.metadata !== undefined) {
			if (!isJsonObject(provenanceValue.metadata)) return undefined;
			const sourceLineRef =
				provenanceValue.metadata.sourceLineRef === undefined
					? undefined
					: bridgeCasRef(provenanceValue.metadata.sourceLineRef);
			const sourceMessageRef =
				provenanceValue.metadata.sourceMessageRef === undefined
					? undefined
					: bridgeCasRef(provenanceValue.metadata.sourceMessageRef);
			const titleSlotRef =
				provenanceValue.metadata.titleSlotRef === undefined
					? undefined
					: bridgeCasRef(provenanceValue.metadata.titleSlotRef);
			if (
				(provenanceValue.metadata.sourceLineRef !== undefined && sourceLineRef === undefined) ||
				(provenanceValue.metadata.sourceMessageRef !== undefined && sourceMessageRef === undefined) ||
				(provenanceValue.metadata.titleSlotRef !== undefined && titleSlotRef === undefined)
			)
				return undefined;
			metadata = {
				...(sourceLineRef === undefined ? {} : { sourceLineRef }),
				...(sourceMessageRef === undefined ? {} : { sourceMessageRef }),
				...(titleSlotRef === undefined ? {} : { titleSlotRef }),
			};
		}
		const toolPairs: BridgePairProvenance[] = [];
		const seenPairIndexes = new Set<number>();
		for (const [pairIndex, pairValue] of provenanceValue.toolPairs.entries()) {
			if (
				!isJsonObject(pairValue) ||
				typeof pairValue.toolName !== "string" ||
				typeof pairValue.callId !== "string" ||
				!hasOwn(pairValue, "argsSnapshot") ||
				!isJsonValue(pairValue.argsSnapshot)
			)
				return undefined;
			const declaredIndex = pairValue.pairIndex;
			if (
				declaredIndex !== undefined &&
				(typeof declaredIndex !== "number" || !Number.isSafeInteger(declaredIndex) || declaredIndex < 0)
			)
				return undefined;
			const resolvedIndex = declaredIndex ?? pairIndex;
			if (seenPairIndexes.has(resolvedIndex)) return undefined;
			seenPairIndexes.add(resolvedIndex);
			const originalCallRef =
				pairValue.originalCallRef === undefined ? undefined : bridgeCasRef(pairValue.originalCallRef);
			const synthesizedCallRef =
				pairValue.synthesizedCallRef === undefined ? undefined : bridgeCasRef(pairValue.synthesizedCallRef);
			const resultRef = pairValue.resultRef === undefined ? undefined : bridgeCasRef(pairValue.resultRef);
			if (
				(pairValue.originalCallRef !== undefined && originalCallRef === undefined) ||
				(pairValue.synthesizedCallRef !== undefined && synthesizedCallRef === undefined) ||
				(pairValue.resultRef !== undefined && resultRef === undefined)
			)
				return undefined;
			toolPairs.push({
				pairIndex: resolvedIndex,
				toolName: pairValue.toolName,
				callId: pairValue.callId,
				argsSnapshot: pairValue.argsSnapshot,
				...(originalCallRef === undefined ? {} : { originalCallRef }),
				...(synthesizedCallRef === undefined ? {} : { synthesizedCallRef }),
				...(resultRef === undefined ? {} : { resultRef }),
			});
		}
		provenance[nodeId] = {
			role,
			...(thinkingRef === undefined ? {} : { thinkingRef }),
			...(providerPayloadRef === undefined ? {} : { providerPayloadRef }),
			...(metadata === undefined ? {} : { metadata }),
			toolPairs,
		};
	}
	if (Object.keys(nativeIdMap).some(nodeId => !hasOwn(provenance, nodeId))) return undefined;
	const tails = Object.create(null) as Record<string, readonly string[]>;
	if (value.tails !== undefined) {
		if (!isJsonObject(value.tails)) return undefined;
		for (const [nodeId, tailValue] of Object.entries(value.tails)) {
			if (!Array.isArray(tailValue) || tailValue.length === 0) return undefined;
			if (!tailValue.every(item => typeof item === "string" && /^[0-9a-f]{8}$/.test(item))) return undefined;
			tails[nodeId] = [...tailValue] as readonly string[];
		}
	}
	return {
		activeLeafId: value.activeLeafId,
		header: sourceRef === undefined ? {} : { sourceRef },
		nativeIdMap,
		lossLedger,
		provenance,
		tails,
	};
}

function mergeLosses(...ledgers: readonly SessionLoss[][]): SessionLoss[] {
	const seen = new Set<string>();
	const result: SessionLoss[] = [];
	for (const ledger of ledgers)
		for (const loss of ledger) {
			const key = JSON.stringify(loss);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(loss);
		}
	return result;
}

function contentFor(entry: PrimeJsonObject, message: PrimeJsonObject | undefined): JsonValue {
	if (message?.content !== undefined) return message.content;
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary as JsonValue;
	if (entry.type === "custom") return entry.data ?? entry;
	if (entry.type === "custom_message") return entry.content as JsonValue;
	return entry;
}
function roleFor(entry: PrimeJsonObject, message: PrimeJsonObject | undefined): SessionSpecNode["role"] {
	if (entry.type === "compaction") return "compaction";
	if (entry.type === "custom" || entry.type === "custom_message") return "custom";
	if (entry.type !== "message") return "custom";
	if (message?.role === "user" || message?.role === "assistant" || message?.role === "toolResult") return message.role;
	return "custom";
}
function customMetadata(entry: PrimeJsonObject, message: PrimeJsonObject | undefined): Record<string, JsonValue> {
	const metadata: Record<string, JsonValue> = {};
	const copy = (source: PrimeJsonObject, keys: readonly string[]): void => {
		for (const key of keys) {
			const value = source[key];
			if (value !== undefined && isJsonValue(value)) metadata[key] = value;
		}
	};
	if (entry.type === "custom" || entry.type === "custom_message")
		copy(entry, ["customType", "display", "details", "attribution", "fromExtension"]);
	if (entry.type === "compaction") copy(entry, ["details", "fromHook", "customInstructions"]);
	if (entry.type === "branch_summary") copy(entry, ["details", "fromHook"]);
	if (message?.role === "custom") copy(message, ["customType", "display", "details", "attribution"]);
	else if (message?.role === "toolResult") copy(message, ["details", "isError"]);
	return metadata;
}

export async function readPrimeSession(
	path: string,
	cas: FileCas,
	options?: { readonly trustedBridgeDigest?: string },
): Promise<SessionSpecV1> {
	if (options?.trustedBridgeDigest !== undefined && !/^[0-9a-f]{64}$/.test(options.trustedBridgeDigest))
		throw new Error("trustedBridgeDigest must be a lowercase SHA-256 hex digest");
	const fileBytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	const lines = parsePhysicalLines(fileBytes);
	if (lines.length === 0) throw new Error("Prime session is empty or has no physical JSON object");
	const header = validateHeader(lines[0].value);
	const entries = lines.slice(1);
	for (const line of entries) {
		validateEntryShape(line.value);
		if (KNOWN_ENTRY_TYPES[line.value.type as string] === true) validateKnownEntry(line.value);
	}
	validatePhysicalTree(entries.map(line => line.value));
	const bridgeCandidate = entries.find(
		line => line.value.type === "custom_message" && line.value.customType === BRIDGE_CUSTOM_TYPE,
	);
	const parsedBridge = bridgeCandidate === undefined ? undefined : parseBridgeDetails(bridgeCandidate.value.details);
	const trustedBridge =
		options?.trustedBridgeDigest !== undefined && bridgeDigest(fileBytes) === options.trustedBridgeDigest;
	if (trustedBridge && bridgeCandidate !== undefined && parsedBridge === undefined)
		throw new Error("Prime bridge metadata is malformed");
	let bridge:
		| {
				readonly entryId: string;
				readonly details: BridgeDetails;
				readonly primeToCanonical: ReadonlyMap<string, string>;
				readonly tailPrimeToSynthetic: ReadonlyMap<string, string>;
		  }
		| undefined;
	if (bridgeCandidate !== undefined && parsedBridge !== undefined) {
		const primeToCanonical = new Map<string, string>();
		const canonicalEntries = entries.filter(line => line.value.id !== bridgeCandidate.value.id);
		const entriesByPrime = new Map(canonicalEntries.map(line => [String(line.value.id), line.value]));
		const canonicalPrimes = new Set<string>();
		let valid = true;
		for (const [canonicalId, pair] of Object.entries(parsedBridge.nativeIdMap)) {
			const prime = pair.prime;
			if (prime === undefined || canonicalPrimes.has(prime)) {
				valid = false;
				break;
			}
			canonicalPrimes.add(prime);
			primeToCanonical.set(prime, canonicalId);
		}
		const tailPrimeOwners = new Map<string, string>();
		for (const [nodeId, tailIds] of Object.entries(parsedBridge.tails)) {
			if (!hasOwn(parsedBridge.nativeIdMap, nodeId)) {
				valid = false;
				break;
			}
			for (const tailId of tailIds) {
				if (canonicalPrimes.has(tailId) || tailPrimeOwners.has(tailId)) {
					valid = false;
					break;
				}
				tailPrimeOwners.set(tailId, nodeId);
			}
			if (!valid) break;
		}
		const expectedPhysicalIds = new Set([...canonicalPrimes, ...tailPrimeOwners.keys()]);
		if (
			canonicalEntries.length !== expectedPhysicalIds.size ||
			canonicalEntries.some(line => !expectedPhysicalIds.has(String(line.value.id))) ||
			Object.keys(parsedBridge.provenance).some(nodeId => !hasOwn(parsedBridge.nativeIdMap, nodeId))
		)
			valid = false;
		const activePrime =
			parsedBridge.activeLeafId === null
				? null
				: !hasOwn(parsedBridge.nativeIdMap, parsedBridge.activeLeafId)
					? undefined
					: parsedBridge.nativeIdMap[parsedBridge.activeLeafId]?.prime;
		if (
			(parsedBridge.activeLeafId !== null && activePrime === undefined) ||
			(activePrime !== null &&
				activePrime !== undefined &&
				canonicalEntries.some(line => line.value.parentId === activePrime))
		)
			valid = false;
		for (const [nodeId, tailIds] of Object.entries(parsedBridge.tails)) {
			const basePrime = parsedBridge.nativeIdMap[nodeId]?.prime;
			const base = basePrime === undefined ? undefined : entriesByPrime.get(basePrime);
			if (
				base === undefined ||
				roleFor(base, isJsonObject(base.message) ? base.message : undefined) !== "toolResult"
			) {
				valid = false;
				break;
			}
			let previous: string | undefined;
			for (const [index, tailPrime] of tailIds.entries()) {
				const tail = entriesByPrime.get(tailPrime);
				if (
					tail === undefined ||
					roleFor(tail, isJsonObject(tail.message) ? tail.message : undefined) !== "toolResult" ||
					(index > 0 && String(tail.parentId) !== previous)
				) {
					valid = false;
					break;
				}
				previous = tailPrime;
			}
			if (!valid) break;
			if (tailIds.length > 0 && String(base.parentId) !== tailIds.at(-1)) valid = false;
		}
		if (!valid && trustedBridge) throw new Error("Prime bridge metadata does not match the native session");
		if (valid && trustedBridge) {
			const references: CasRef[] = [];
			if (parsedBridge.header.sourceRef !== undefined) references.push(parsedBridge.header.sourceRef);
			for (const provenance of Object.values(parsedBridge.provenance)) {
				for (const ref of [
					provenance.thinkingRef,
					provenance.providerPayloadRef,
					provenance.metadata?.sourceLineRef,
					provenance.metadata?.sourceMessageRef,
					provenance.metadata?.titleSlotRef,
				])
					if (ref !== undefined) references.push(ref);
				for (const pair of provenance.toolPairs)
					for (const ref of [pair.originalCallRef, pair.synthesizedCallRef, pair.resultRef])
						if (ref !== undefined) references.push(ref);
			}
			for (const reference of references)
				if ((await cas.get(reference)) === undefined)
					throw new Error(`Prime bridge CAS reference is unavailable: ${reference.hash}`);
			const tailPrimeToSynthetic = new Map<string, string>();
			const usedNodeIds = new Set<string>([
				...Object.keys(parsedBridge.nativeIdMap),
				...canonicalEntries.map(line => String(line.value.id)),
			]);
			for (const [nodeId, tailIds] of Object.entries(parsedBridge.tails))
				for (const [index, tailPrime] of tailIds.entries()) {
					let synthetic = `${nodeId}\u0000prime-tail\u0000${index}`;
					while (usedNodeIds.has(synthetic)) synthetic += "\u0000";
					usedNodeIds.add(synthetic);
					tailPrimeToSynthetic.set(tailPrime, synthetic);
				}
			bridge = {
				entryId: bridgeCandidate.value.id as string,
				details: parsedBridge,
				primeToCanonical,
				tailPrimeToSynthetic,
			};
		}
	}
	const headerRef = await cas.put(lines[0].bytes);
	const nodes: MutableSessionNode[] = [];
	const nativeIdMap = Object.create(null) as SessionSpecV1["nativeIdMap"];
	if (bridge !== undefined)
		for (const [nodeId, pair] of Object.entries(bridge.details.nativeIdMap)) nativeIdMap[nodeId] = { ...pair };
	const losses: SessionLoss[] = [];
	for (const key of ["parentSession", "rlmDepth", "git"] as const) {
		if (header[key] !== undefined)
			losses.push(
				createLoss(
					"entry_metadata_unrepresentable",
					`Prime header field ${key} is not represented in SessionSpecHeader`,
					undefined,
					"session",
				),
			);
	}
	for (const line of entries) {
		if (bridge?.entryId === line.value.id) continue;
		const entry = line.value;
		const entryId = entry.id as string;
		const nodeId = bridge?.primeToCanonical.get(entryId) ?? bridge?.tailPrimeToSynthetic.get(entryId) ?? entryId;
		const parentPrimeId = entry.parentId as string | null;
		const parentId =
			parentPrimeId === null || parentPrimeId === bridge?.entryId
				? null
				: (bridge?.primeToCanonical.get(parentPrimeId) ??
					bridge?.tailPrimeToSynthetic.get(parentPrimeId) ??
					parentPrimeId);
		const sourceType = String(entry.type);
		const lineRef = await cas.put(line.bytes);
		const message = isJsonObject(entry.message) ? entry.message : undefined;
		const role = roleFor(entry, message);
		const metadata: Record<string, JsonValue> = {
			sourceType,
			...customMetadata(entry, message),
			sourceLineRef: {
				hash: lineRef.hash,
				...(lineRef.byteLength === undefined ? {} : { byteLength: lineRef.byteLength }),
			},
		};
		const node: MutableSessionNode = {
			id: nodeId,
			parentId,
			role,
			content: contentFor(entry, message),
			metadata,
		};
		if (
			!hasOwn(nativeIdMap, node.id) &&
			bridge?.entryId !== entryId &&
			bridge?.tailPrimeToSynthetic.has(entryId) !== true
		)
			nativeIdMap[node.id] = { prime: entryId };
		if (KNOWN_ENTRY_TYPES[sourceType] !== true)
			losses.push(
				createLoss("unsupported_role", `Unsupported Prime entry type: ${sourceType}`, node.id, sourceType),
			);
		if (sourceType === "message") {
			const messageSpan = propertySpan(line.text, "message");
			if (messageSpan === undefined)
				throw new Error(`Prime message entry ${node.id} has no recoverable message object`);
			const sourceMessageRef = await putText(cas, line.text.slice(messageSpan.start, messageSpan.end));
			metadata.sourceMessageRef = {
				hash: sourceMessageRef.hash,
				...(sourceMessageRef.byteLength === undefined ? {} : { byteLength: sourceMessageRef.byteLength }),
			};
			if (message?.role === "custom") {
				if (message.customType !== undefined) metadata.customType = message.customType;
				if (message.display !== undefined) metadata.display = message.display;
				if (message.details !== undefined) metadata.details = message.details;
			} else if (role === "custom" && message?.role !== undefined) {
				losses.push(
					createLoss(
						"unsupported_role",
						`Unsupported Prime message role: ${String(message.role)}`,
						node.id,
						"message",
					),
				);
			}
			if (role === "toolResult") {
				const callId = stringProperty(message ?? {}, "toolCallId");
				const toolName = stringProperty(message ?? {}, "toolName");
				if (callId !== undefined && toolName !== undefined)
					node.toolPairs = [{ toolName, callId, argsSnapshot: {}, resultRef: sourceMessageRef }];
			}
			if (role === "assistant" && message !== undefined) {
				const contentSpan = propertySpan(line.text.slice(messageSpan.start, messageSpan.end), "content");
				if (contentSpan !== undefined) {
					const absolute = {
						start: messageSpan.start + contentSpan.start,
						end: messageSpan.start + contentSpan.end,
					};
					const pairs: NonNullable<SessionSpecNode["toolPairs"]> = [];
					for (const blockSpan of arraySpans(line.text, absolute)) {
						const blockText = line.text.slice(blockSpan.start, blockSpan.end);
						let block: unknown;
						try {
							block = JSON.parse(blockText);
						} catch {
							throw new Error(`Prime assistant ${node.id} contains malformed content`);
						}
						if (!isJsonObject(block))
							throw new Error(`Prime assistant ${node.id} contains invalid content block`);
						if (block.type === "toolCall") {
							const callId = stringProperty(block, "id");
							const toolName = stringProperty(block, "name");
							if (callId === undefined || toolName === undefined || !isJsonObject(block.arguments))
								throw new Error(`Prime assistant ${node.id} has malformed toolCall`);
							pairs.push({
								toolName,
								callId,
								argsSnapshot: block.arguments,
								originalCallRef: await putText(cas, blockText),
							});
						}
						if (block.type === "thinking") {
							node.thinkingRef = await putText(cas, blockText);
							const signature = propertySpan(blockText, "thinkingSignature");
							if (signature !== undefined)
								node.providerPayloadRef = await putText(cas, blockText.slice(signature.start, signature.end));
						}
					}
					if (pairs.length > 0) node.toolPairs = pairs;
				}
			}
		}
		nodes.push(node);
	}
	if (bridge !== undefined) {
		const nodeById = new Map(nodes.map(node => [node.id, node]));
		const removed = new Set<string>();
		for (const [nodeId, tailPrimes] of Object.entries(bridge.details.tails)) {
			const base = nodeById.get(nodeId);
			const synthetic = tailPrimes
				.map(tailPrime => {
					const syntheticId = bridge.tailPrimeToSynthetic.get(tailPrime);
					return syntheticId === undefined ? undefined : nodeById.get(syntheticId);
				})
				.filter((node): node is MutableSessionNode => node !== undefined);
			if (
				base === undefined ||
				base.role !== "toolResult" ||
				synthetic.length !== tailPrimes.length ||
				synthetic.some(
					(node, index) => node.role !== "toolResult" || (index > 0 && node.parentId !== synthetic[index - 1]!.id),
				) ||
				base.parentId !== synthetic.at(-1)!.id
			)
				continue;
			base.parentId = synthetic[0]!.parentId;
			base.toolPairs = [...synthetic.flatMap(node => node.toolPairs ?? []), ...(base.toolPairs ?? [])];
			for (const node of synthetic) removed.add(node.id);
		}
		if (removed.size > 0) {
			let writeIndex = 0;
			for (const node of nodes) if (!removed.has(node.id)) nodes[writeIndex++] = node;
			nodes.length = writeIndex;
		}
		for (const [nodeId, provenance] of Object.entries(bridge.details.provenance)) {
			const node = nodes.find(candidate => candidate.id === nodeId);
			if (node === undefined) continue;
			node.role = provenance.role;
			if (provenance.thinkingRef !== undefined) node.thinkingRef = provenance.thinkingRef;
			if (provenance.providerPayloadRef !== undefined) node.providerPayloadRef = provenance.providerPayloadRef;
			if (provenance.metadata !== undefined) {
				const metadata = node.metadata ?? {};
				node.metadata = metadata;
				for (const [key, ref] of Object.entries(provenance.metadata))
					if (ref !== undefined)
						metadata[key] = {
							hash: ref.hash,
							...(ref.byteLength === undefined ? {} : { byteLength: ref.byteLength }),
						};
			}
			if (node.toolPairs !== undefined)
				node.toolPairs = node.toolPairs.map((pair, pairIndex) => {
					const source = provenance.toolPairs.find(candidate => candidate.pairIndex === pairIndex);
					return source === undefined
						? pair
						: {
								toolName: source.toolName,
								callId: source.callId,
								argsSnapshot: source.argsSnapshot,
								...(source.originalCallRef === undefined ? {} : { originalCallRef: source.originalCallRef }),
								...(source.synthesizedCallRef === undefined
									? {}
									: { synthesizedCallRef: source.synthesizedCallRef }),
								...(source.resultRef === undefined ? {} : { resultRef: source.resultRef }),
							};
				});
		}
		const nodeByCanonicalId = new Map(nodes.map(node => [node.id, node]));
		const orderedNodes = Object.keys(bridge.details.nativeIdMap).map(nodeId => nodeByCanonicalId.get(nodeId));
		if (orderedNodes.every((node): node is MutableSessionNode => node !== undefined)) {
			nodes.length = 0;
			nodes.push(...orderedNodes);
		}
		const generatedLosses = [...losses];
		losses.length = 0;
		losses.push(...mergeLosses(bridge.details.lossLedger, generatedLosses));
	}
	losses.push(
		createLoss(
			"missing_source_bytes",
			"Prime v3 does not persist provider request/response payload bytes",
			undefined,
			"provider_payload",
		),
	);
	const spec: SessionSpecV1 = {
		specVersion: 1,
		header: {
			originHarness: "prime",
			sourceSessionId: header.id,
			title: basename(path),
			cwd: header.cwd,
			createdAt: header.timestamp,
			sourceSchema: "prime-session-v3",
			sourceRef: bridge?.details.header.sourceRef ?? headerRef,
		},
		nodes,
		activeLeafId: bridge === undefined ? (nodes[nodes.length - 1]?.id ?? null) : bridge.details.activeLeafId,
		nativeIdMap,
		lossLedger: mergeLosses(losses),
	};
	return validateSessionSpec(spec);
}

export type { PrimeSessionHeader } from "./prime-types";
