import { type } from "@oh-my-pi/omptype";
import { type SessionLoss, validateLossLedger } from "./loss-ledger";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CasRef {
	readonly hash: string;
	readonly byteLength?: number;
}

export interface SessionSpecHeader {
	readonly originHarness: string;
	readonly sourceSessionId: string;
	readonly title: string;
	readonly cwd: string;
	readonly createdAt: string;
	readonly sourceSchema: string;
	readonly sourceRef?: CasRef;
}

export type CanonicalRole = "system" | "user" | "assistant" | "toolResult" | "compaction" | "custom";

export interface CanonicalToolPair {
	readonly toolName: string;
	readonly callId: string;
	readonly argsSnapshot: JsonValue;
	readonly originalCallRef?: CasRef;
	readonly synthesizedCallRef?: CasRef;
	readonly resultRef?: CasRef;
}

export interface SessionSpecNode {
	readonly id: string;
	readonly parentId: string | null;
	readonly role: CanonicalRole;
	readonly content: JsonValue;
	toolPairs?: CanonicalToolPair[];
	readonly thinkingRef?: CasRef;
	readonly providerPayloadRef?: CasRef;
	readonly metadata?: { [key: string]: JsonValue };
}

export interface NativeIdPair {
	readonly prime?: string;
	readonly omp?: string;
}

export interface SessionSpecV1 {
	readonly specVersion: 1;
	readonly header: SessionSpecHeader;
	nodes: SessionSpecNode[];
	activeLeafId: string | null;
	readonly nativeIdMap: { [key: string]: NativeIdPair };
	lossLedger: SessionLoss[];
}

export class SessionSpecValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionSpecValidationError";
	}
}

const roles: readonly CanonicalRole[] = ["system", "user", "assistant", "toolResult", "compaction", "custom"];
const casHashPattern = /^[0-9a-f]{64}$/;

function fail(message: string): never {
	throw new SessionSpecValidationError(message);
}

function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, name: string): { [key: string]: unknown } {
	if (!isObject(value)) fail(`${name} must be an object`);
	return value;
}

function expectString(value: unknown, name: string): string {
	if (typeof value !== "string") fail(`${name} must be a string`);
	return value;
}

export function hasDuplicateJsonKeys(text: string): boolean {
	let index = 0;
	const skipWhitespace = (): void => {
		while (
			index < text.length &&
			(text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")
		)
			index++;
	};
	const parseString = (): string | undefined => {
		if (text[index] !== '"') return undefined;
		const start = index;
		let escaped = false;
		for (index++; index < text.length; index++) {
			const character = text[index]!;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') {
				const raw = text.slice(start, index + 1);
				try {
					const value = JSON.parse(raw);
					if (typeof value !== "string") return undefined;
					index++;
					return value;
				} catch {
					return undefined;
				}
			} else if (character < " ") return undefined;
		}
		return undefined;
	};
	const parseValue = (): { readonly valid: boolean; readonly duplicate: boolean } => {
		skipWhitespace();
		if (text[index] === '"') return { valid: parseString() !== undefined, duplicate: false };
		if (text[index] === "{") return parseObject();
		if (text[index] === "[") return parseArray();
		const start = index;
		while (
			index < text.length &&
			text[index] !== "," &&
			text[index] !== "]" &&
			text[index] !== "}" &&
			text[index] !== " " &&
			text[index] !== "\t" &&
			text[index] !== "\r" &&
			text[index] !== "\n"
		)
			index++;
		if (start === index) return { valid: false, duplicate: false };
		try {
			JSON.parse(text.slice(start, index));
			return { valid: true, duplicate: false };
		} catch {
			return { valid: false, duplicate: false };
		}
	};
	const parseObject = (): { readonly valid: boolean; readonly duplicate: boolean } => {
		index++;
		const keys = new Set<string>();
		let duplicate = false;
		skipWhitespace();
		if (text[index] === "}") {
			index++;
			return { valid: true, duplicate: false };
		}
		for (;;) {
			skipWhitespace();
			const key = parseString();
			if (key === undefined) return { valid: false, duplicate };
			if (keys.has(key)) duplicate = true;
			keys.add(key);
			skipWhitespace();
			if (text[index] !== ":") return { valid: false, duplicate };
			index++;
			const value = parseValue();
			if (!value.valid) return { valid: false, duplicate: duplicate || value.duplicate };
			duplicate ||= value.duplicate;
			skipWhitespace();
			if (text[index] === "}") {
				index++;
				return { valid: true, duplicate };
			}
			if (text[index] !== ",") return { valid: false, duplicate };
			index++;
		}
	};
	const parseArray = (): { readonly valid: boolean; readonly duplicate: boolean } => {
		index++;
		let duplicate = false;
		skipWhitespace();
		if (text[index] === "]") {
			index++;
			return { valid: true, duplicate: false };
		}
		for (;;) {
			const value = parseValue();
			if (!value.valid) return { valid: false, duplicate: duplicate || value.duplicate };
			duplicate ||= value.duplicate;
			skipWhitespace();
			if (text[index] === "]") {
				index++;
				return { valid: true, duplicate };
			}
			if (text[index] !== ",") return { valid: false, duplicate };
			index++;
		}
	};
	const result = parseValue();
	skipWhitespace();
	return result.valid && index === text.length && result.duplicate;
}

function assertJsonValue(value: unknown, name: string): asserts value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		fail(`${name} must contain finite numbers`);
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			assertJsonValue(item, `${name}[${index}]`);
		});
		return;
	}
	if (isObject(value)) {
		for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${name}.${key}`);
		return;
	}
	fail(`${name} must be JSON-compatible`);
}

function assertCasRef(value: unknown, name: string): asserts value is CasRef {
	const ref = expectObject(value, name);
	if (!casHashPattern.test(expectString(ref.hash, `${name}.hash`)))
		fail(`${name}.hash must be a lowercase SHA-256 hash`);
	if (
		ref.byteLength !== undefined &&
		(typeof ref.byteLength !== "number" || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0)
	) {
		fail(`${name}.byteLength must be a non-negative integer`);
	}
}

function assertToolPair(value: unknown, name: string): asserts value is CanonicalToolPair {
	const pair = expectObject(value, name);
	if (expectString(pair.toolName, `${name}.toolName`).length === 0) fail(`${name}.toolName must not be empty`);
	if (expectString(pair.callId, `${name}.callId`).length === 0) fail(`${name}.callId must not be empty`);
	assertJsonValue(pair.argsSnapshot, `${name}.argsSnapshot`);
	for (const key of ["originalCallRef", "synthesizedCallRef", "resultRef"] as const) {
		if (pair[key] !== undefined) assertCasRef(pair[key], `${name}.${key}`);
	}
}

function assertNode(value: unknown, index: number): asserts value is SessionSpecNode {
	const node = expectObject(value, `nodes[${index}]`);
	expectString(node.id, `nodes[${index}].id`);
	if (node.parentId !== null) expectString(node.parentId, `nodes[${index}].parentId`);
	if (typeof node.role !== "string" || !roles.includes(node.role as CanonicalRole))
		fail(`nodes[${index}].role is unsupported`);
	assertJsonValue(node.content, `nodes[${index}].content`);
	if (node.toolPairs !== undefined) {
		if (!Array.isArray(node.toolPairs)) fail(`nodes[${index}].toolPairs must be an array`);
		node.toolPairs.forEach((pair, pairIndex) => {
			assertToolPair(pair, `nodes[${index}].toolPairs[${pairIndex}]`);
			if (node.role === "assistant" && pair.resultRef !== undefined)
				fail(`nodes[${index}] assistant tool pairs cannot contain resultRef`);
			if (node.role !== "toolResult" && pair.resultRef !== undefined)
				fail(`nodes[${index}] resultRef requires a toolResult node`);
		});
	}
	for (const key of ["thinkingRef", "providerPayloadRef"] as const) {
		if (node[key] !== undefined) assertCasRef(node[key], `nodes[${index}].${key}`);
	}
	if (node.metadata !== undefined) {
		const metadata = expectObject(node.metadata, `nodes[${index}].metadata`);
		for (const [key, item] of Object.entries(metadata)) assertJsonValue(item, `nodes[${index}].metadata.${key}`);
	}
}

function assertHeader(value: unknown): asserts value is SessionSpecHeader {
	const header = expectObject(value, "header");
	for (const key of ["originHarness", "sourceSessionId", "title", "cwd", "createdAt", "sourceSchema"] as const) {
		expectString(header[key], `header.${key}`);
	}
	if (header.sourceRef !== undefined) assertCasRef(header.sourceRef, "header.sourceRef");
}

function assertNativeIdMap(value: unknown): asserts value is { [key: string]: NativeIdPair } {
	const map = expectObject(value, "nativeIdMap");
	for (const [key, pairValue] of Object.entries(map)) {
		const pair = expectObject(pairValue, `nativeIdMap.${key}`);
		if (pair.prime !== undefined) expectString(pair.prime, `nativeIdMap.${key}.prime`);
		if (pair.omp !== undefined) expectString(pair.omp, `nativeIdMap.${key}.omp`);
	}
}

function assertUniqueToolCallIds(nodes: readonly SessionSpecNode[], byId: ReadonlyMap<string, SessionSpecNode>): void {
	for (const node of nodes) {
		if (node.role !== "assistant" || node.toolPairs === undefined) continue;
		const nodeCallIds = new Set<string>();
		for (const pair of node.toolPairs) {
			if (nodeCallIds.has(pair.callId)) fail(`assistant node ${node.id} has duplicate tool call ID ${pair.callId}`);
			nodeCallIds.add(pair.callId);
			let ancestorId = node.parentId;
			while (ancestorId !== null) {
				const ancestor = byId.get(ancestorId);
				if (ancestor?.role === "assistant" && ancestor.toolPairs?.some(call => call.callId === pair.callId))
					fail(`assistant node ${node.id} has duplicate tool call ID ${pair.callId} on its ancestry path`);
				ancestorId = ancestor?.parentId ?? null;
			}
		}
	}
}

function assertToolContinuity(nodes: readonly SessionSpecNode[], byId: ReadonlyMap<string, SessionSpecNode>): void {
	for (const node of nodes) {
		if (node.role !== "toolResult") continue;
		if (node.toolPairs === undefined || node.toolPairs.length === 0)
			fail(`tool result node ${node.id} must have a tool pair`);
		for (const pair of node.toolPairs) {
			let ancestorId = node.parentId;
			let found = false;
			while (ancestorId !== null) {
				const ancestor = byId.get(ancestorId);
				if (
					ancestor?.role === "assistant" &&
					ancestor.toolPairs?.some(call => call.callId === pair.callId && call.toolName === pair.toolName)
				) {
					found = true;
					break;
				}
				ancestorId = ancestor?.parentId ?? null;
			}
			if (!found)
				fail(
					`tool result node ${node.id} call ${pair.callId}/${pair.toolName} has no preceding tool call on its ancestry path`,
				);
		}
	}
}

function assertSessionSpec(value: unknown): asserts value is SessionSpecV1 {
	const spec = expectObject(value, "session spec");
	if (spec.specVersion !== 1) fail("specVersion must be 1");
	assertHeader(spec.header);
	if (!Array.isArray(spec.nodes)) fail("nodes must be an array");
	const nodes = spec.nodes;
	nodes.forEach((node, index) => {
		assertNode(node, index);
	});
	const canonicalNodes = nodes as SessionSpecNode[];
	const activeLeafId = spec.activeLeafId === null ? null : expectString(spec.activeLeafId, "activeLeafId");
	assertNativeIdMap(spec.nativeIdMap);
	validateLossLedger(spec.lossLedger);

	const byId = new Map<string, SessionSpecNode>();
	for (const node of canonicalNodes) {
		if (byId.has(node.id)) fail("nodes must have unique node IDs");
		byId.set(node.id, node);
	}
	for (const node of canonicalNodes) {
		if (node.parentId !== null && !byId.has(node.parentId)) fail(`node ${node.id} has a missing parent`);
	}
	for (const node of canonicalNodes) {
		const seen = new Set<string>();
		let current: SessionSpecNode | undefined = node;
		while (current !== undefined && current.parentId !== null) {
			if (seen.has(current.id)) fail("nodes must not contain a cycle");
			seen.add(current.id);
			current = byId.get(current.parentId);
		}
	}
	if (activeLeafId !== null) {
		const active = byId.get(activeLeafId);
		if (active === undefined) fail("activeLeafId must refer to an existing node");
		if (canonicalNodes.some(node => node.parentId === active.id)) fail("activeLeafId must refer to a leaf node");
	}
	assertUniqueToolCallIds(canonicalNodes, byId);
	assertToolContinuity(canonicalNodes, byId);
}

export const sessionSpecSchema = type("unknown").narrow((value, context) => {
	try {
		assertSessionSpec(value);
		return true;
	} catch (error) {
		return context.mustBe(error instanceof Error ? error.message : "a valid SessionSpecV1");
	}
});

export function validateSessionSpec(value: unknown): SessionSpecV1 {
	assertSessionSpec(value);
	return value as SessionSpecV1;
}
