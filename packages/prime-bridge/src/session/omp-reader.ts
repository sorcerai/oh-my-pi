import { basename, join } from "node:path";
import { getBlobsDir } from "@oh-my-pi/pi-utils/dirs";
import { FileCas } from "./cas";
import { createLoss, type SessionLoss, validateLossLedger } from "./loss-ledger";
import type { OmpJsonObject, OmpSessionHeader, OmpSessionTitleSlot } from "./omp-types";
import type { CanonicalToolPair, CasRef, JsonValue, SessionSpecNode, SessionSpecV1 } from "./spec";
import { hasDuplicateJsonKeys, validateSessionSpec } from "./spec";

interface PhysicalLine {
	readonly bytes: Uint8Array;
	readonly text: string;
	readonly value: OmpJsonObject;
}

interface Span {
	readonly start: number;
	readonly end: number;
}

interface OmpReadOptions {
	readonly ompAgentDir?: string;
	readonly trustedBridgeDigest?: string;
}

const BRIDGE_CUSTOM_TYPE = "prime-bridge/session-resume";
type MutableSessionNode = { -readonly [Key in keyof SessionSpecNode]: SessionSpecNode[Key] };
const CANONICAL_ROLES: Readonly<Record<SessionSpecNode["role"], true>> = {
	user: true,
	assistant: true,
	toolResult: true,
	system: true,
	custom: true,
	compaction: true,
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const BLOB_REF_PATTERN = /^blob:sha256:([a-f0-9]{64})$/;
const KNOWN_ENTRY_TYPES: Record<string, true> = {
	message: true,
	thinking_level_change: true,
	model_change: true,
	service_tier_change: true,
	compaction: true,
	branch_summary: true,
	reset_boundary: true,
	custom: true,
	custom_message: true,
	label: true,
	title_change: true,
	ttsr_injection: true,
	credential_pin: true,
	session_init: true,
	mode_change: true,
};
const SERVICE_TIERS: Record<string, true> = {
	auto: true,
	default: true,
	flex: true,
	scale: true,
	priority: true,
};
const STOP_REASONS: Record<string, true> = {
	stop: true,
	length: true,
	toolUse: true,
	error: true,
	aborted: true,
};
const MESSAGE_ROLES: Record<string, true> = {
	user: true,
	developer: true,
	assistant: true,
	toolResult: true,
	custom: true,
	hookMessage: true,
	branchSummary: true,
	compactionSummary: true,
	bashExecution: true,
	pythonExecution: true,
	fileMention: true,
};
function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw new Error(`${context} has unsupported field ${key}`);
	}
}

function parseTitleSlotLine(line: string): OmpSessionTitleSlot | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.type !== "title" || value.v !== 1) return undefined;
		assertAllowedKeys(value, ["type", "v", "title", "source", "updatedAt", "pad"], "OMP title slot");
		if (typeof value.title !== "string" || typeof value.updatedAt !== "string" || typeof value.pad !== "string")
			return undefined;
		if (value.source !== undefined && value.source !== "auto" && value.source !== "user") return undefined;
		return {
			type: "title",
			v: 1,
			title: value.title,
			updatedAt: value.updatedAt,
			pad: value.pad,
			...(value.source === undefined ? {} : { source: value.source }),
		};
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isJsonValue(item));
	return isRecord(value) && Object.values(value).every(item => isJsonValue(item));
}

function isJsonObject(value: unknown): value is OmpJsonObject {
	return isJsonValue(value) && isRecord(value);
}

function requireString(value: Record<string, unknown>, key: string, context: string): string {
	const result = value[key];
	if (typeof result !== "string") throw new Error(`${context} requires string field ${key}`);
	return result;
}
function requireNonEmptyString(value: Record<string, unknown>, key: string, context: string): string {
	const result = requireString(value, key, context);
	if (result.length === 0) throw new Error(`${context} requires non-empty string field ${key}`);
	return result;
}

function optionalString(value: Record<string, unknown>, key: string, context: string): void {
	if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${context} has invalid ${key}`);
}

function requireFiniteNumber(value: Record<string, unknown>, key: string, context: string): number {
	const result = value[key];
	if (typeof result !== "number" || !Number.isFinite(result))
		throw new Error(`${context} requires finite number field ${key}`);
	return result;
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string, context: string): void {
	if (value[key] !== undefined) requireFiniteNumber(value, key, context);
}

function requireBoolean(value: Record<string, unknown>, key: string, context: string): void {
	if (typeof value[key] !== "boolean") throw new Error(`${context} requires boolean field ${key}`);
}

function optionalBoolean(value: Record<string, unknown>, key: string, context: string): void {
	if (value[key] !== undefined) requireBoolean(value, key, context);
}

function requireObject(value: Record<string, unknown>, key: string, context: string): Record<string, unknown> {
	const result = value[key];
	if (!isRecord(result)) throw new Error(`${context} requires object field ${key}`);
	return result;
}

function optionalObject(
	value: Record<string, unknown>,
	key: string,
	context: string,
): Record<string, unknown> | undefined {
	if (value[key] === undefined) return undefined;
	return requireObject(value, key, context);
}

function optionalJson(value: Record<string, unknown>, key: string, context: string): void {
	if (value[key] !== undefined && !isJsonValue(value[key])) throw new Error(`${context} has invalid ${key}`);
}

function requireStringArray(value: Record<string, unknown>, key: string, context: string): void {
	if (!Array.isArray(value[key]) || !value[key].every(item => typeof item === "string"))
		throw new Error(`${context} ${key} must be an array of strings`);
}

function validateImageContent(value: Record<string, unknown>, context: string): void {
	assertAllowedKeys(value, ["type", "data", "mimeType", "detail"], context);
	requireString(value, "data", context);
	requireString(value, "mimeType", context);
	if (
		value.detail !== undefined &&
		value.detail !== "auto" &&
		value.detail !== "low" &&
		value.detail !== "high" &&
		value.detail !== "original"
	)
		throw new Error(`${context} has invalid detail`);
}

function validateTextImageContent(value: unknown, context: string): void {
	if (typeof value === "string") return;
	if (!Array.isArray(value)) throw new Error(`${context} content must be a string or array`);
	for (const [index, block] of value.entries()) {
		const blockContext = `${context} content[${index}]`;
		if (!isRecord(block) || typeof block.type !== "string") throw new Error(`${blockContext} is invalid`);
		if (block.type === "text") {
			assertAllowedKeys(block, ["type", "text", "textSignature"], blockContext);
			requireString(block, "text", blockContext);
			optionalString(block, "textSignature", blockContext);
		} else if (block.type === "image") {
			validateImageContent(block, blockContext);
		} else {
			throw new Error(`${blockContext} has unsupported type ${block.type}`);
		}
	}
}

function validateUsage(value: Record<string, unknown>, context: string): void {
	assertAllowedKeys(
		value,
		[
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"totalTokens",
			"contextTokens",
			"orchestration",
			"premiumRequests",
			"reasoningTokens",
			"cttl",
			"server",
			"cost",
		],
		context,
	);
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"contextTokens",
		"premiumRequests",
		"reasoningTokens",
	] as const)
		optionalFiniteNumber(value, key, context);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		requireFiniteNumber(value, key, context);
	const orchestration = optionalObject(value, "orchestration", context);
	if (orchestration) {
		assertAllowedKeys(orchestration, ["input", "cacheRead", "output"], `${context}.orchestration`);
		optionalFiniteNumber(orchestration, "input", `${context}.orchestration`);
		optionalFiniteNumber(orchestration, "cacheRead", `${context}.orchestration`);
		optionalFiniteNumber(orchestration, "output", `${context}.orchestration`);
	}
	const cttl = optionalObject(value, "cttl", context);
	if (cttl) {
		assertAllowedKeys(cttl, ["ephemeral5m", "ephemeral1h"], `${context}.cttl`);
		optionalFiniteNumber(cttl, "ephemeral5m", `${context}.cttl`);
		optionalFiniteNumber(cttl, "ephemeral1h", `${context}.cttl`);
	}
	const server = optionalObject(value, "server", context);
	if (server) {
		assertAllowedKeys(server, ["webSearch", "webFetch"], `${context}.server`);
		optionalFiniteNumber(server, "webSearch", `${context}.server`);
		optionalFiniteNumber(server, "webFetch", `${context}.server`);
	}
	const cost = requireObject(value, "cost", context);
	assertAllowedKeys(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], `${context}.cost`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		requireFiniteNumber(cost, key, `${context}.cost`);
}

function validateProviderPayload(value: unknown, context: string): void {
	if (!isRecord(value) || value.type !== "openaiResponsesHistory")
		throw new Error(`${context} providerPayload must be an openaiResponsesHistory object`);
	assertAllowedKeys(value, ["type", "provider", "dt", "items"], context);
	optionalString(value, "provider", context);
	optionalBoolean(value, "dt", context);
	if (!Array.isArray(value.items) || !value.items.every(item => isRecord(item) && isJsonValue(item)))
		throw new Error(`${context} items must be an array of JSON objects`);
}

function validateContextSnapshot(value: Record<string, unknown>, context: string): void {
	assertAllowedKeys(
		value,
		["promptTokens", "nonMessageTokens", "historyRewriteTokensRemoved", "lastMessageTimestamp"],
		context,
	);
	requireFiniteNumber(value, "promptTokens", context);
	requireFiniteNumber(value, "nonMessageTokens", context);
	optionalFiniteNumber(value, "historyRewriteTokensRemoved", context);
	optionalFiniteNumber(value, "lastMessageTimestamp", context);
}

function validateRetryRecovery(value: Record<string, unknown>, context: string): void {
	if (value.kind !== "auto-retry" || (value.status !== "recovered" && value.status !== "superseded"))
		throw new Error(`${context} has invalid retry recovery discriminator`);
	const baseKeys = ["kind", "status", "attempt", "recovery", "note"];
	const recoveryKinds: Record<string, true> = { credential: true, model: true, wait: true, plain: true };
	assertAllowedKeys(
		value,
		value.status === "recovered" ? [...baseKeys, "recoveredAt", "supersededBy"] : baseKeys,
		context,
	);
	requireFiniteNumber(value, "attempt", context);
	if (recoveryKinds[value.recovery as string] !== true) throw new Error(`${context} has invalid recovery`);
	requireString(value, "note", context);
	if (value.status === "recovered") {
		requireString(value, "recoveredAt", context);
		const supersededBy = optionalObject(value, "supersededBy", context);
		if (supersededBy) {
			assertAllowedKeys(supersededBy, ["timestamp", "responseId", "provider", "model"], `${context}.supersededBy`);
			requireFiniteNumber(supersededBy, "timestamp", `${context}.supersededBy`);
			optionalString(supersededBy, "responseId", `${context}.supersededBy`);
			requireString(supersededBy, "provider", `${context}.supersededBy`);
			requireString(supersededBy, "model", `${context}.supersededBy`);
		}
	}
}

function validateStopDetails(value: unknown, context: string): void {
	if (value === null) return;
	if (!isRecord(value)) throw new Error(`${context} must be an object or null`);
	assertAllowedKeys(value, ["type", "category", "explanation"], context);
	requireString(value, "type", context);
	if (value.category !== undefined && value.category !== null && typeof value.category !== "string")
		throw new Error(`${context} has invalid category`);
	if (value.explanation !== undefined && value.explanation !== null && typeof value.explanation !== "string")
		throw new Error(`${context} has invalid explanation`);
}

function validateComputerSafetyCheck(value: unknown, context: string): void {
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	assertAllowedKeys(value, ["id", "code", "message"], context);
	requireString(value, "id", context);
	if (value.code !== undefined && value.code !== null && typeof value.code !== "string")
		throw new Error(`${context} has invalid code`);
	if (value.message !== undefined && value.message !== null && typeof value.message !== "string")
		throw new Error(`${context} has invalid message`);
}

function validateComputerAction(value: unknown, context: string): void {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error(`${context} must be an object`);
	const coordinates = (): void => {
		requireFiniteNumber(value, "x", context);
		requireFiniteNumber(value, "y", context);
	};
	const optionalKeys = (): void => {
		if (
			value.keys !== undefined &&
			value.keys !== null &&
			(!Array.isArray(value.keys) || !value.keys.every(item => typeof item === "string"))
		)
			throw new Error(`${context} keys must be an array or null`);
	};
	switch (value.type) {
		case "click":
			assertAllowedKeys(value, ["type", "button", "x", "y", "keys"], context);
			if (!["left", "right", "wheel", "back", "forward"].includes(value.button as string))
				throw new Error(`${context} has invalid button`);
			coordinates();
			optionalKeys();
			return;
		case "double_click":
			assertAllowedKeys(value, ["type", "x", "y", "keys"], context);
			coordinates();
			if (value.keys !== null && (!Array.isArray(value.keys) || !value.keys.every(item => typeof item === "string")))
				throw new Error(`${context} keys must be an array or null`);
			return;
		case "drag":
			assertAllowedKeys(value, ["type", "path", "keys"], context);
			if (!Array.isArray(value.path)) throw new Error(`${context} path must be an array`);
			for (const [index, point] of value.path.entries()) {
				if (!isRecord(point)) throw new Error(`${context}.path[${index}] must be an object`);
				assertAllowedKeys(point, ["x", "y"], `${context}.path[${index}]`);
				requireFiniteNumber(point, "x", `${context}.path[${index}]`);
				requireFiniteNumber(point, "y", `${context}.path[${index}]`);
			}
			optionalKeys();
			return;
		case "keypress":
			assertAllowedKeys(value, ["type", "keys"], context);
			if (!Array.isArray(value.keys) || !value.keys.every(item => typeof item === "string"))
				throw new Error(`${context} keys must be an array`);
			return;
		case "move":
			assertAllowedKeys(value, ["type", "x", "y", "keys"], context);
			coordinates();
			optionalKeys();
			return;
		case "screenshot":
		case "wait":
			assertAllowedKeys(value, ["type"], context);
			return;
		case "scroll":
			assertAllowedKeys(value, ["type", "x", "y", "scroll_x", "scroll_y", "keys"], context);
			coordinates();
			requireFiniteNumber(value, "scroll_x", context);
			requireFiniteNumber(value, "scroll_y", context);
			optionalKeys();
			return;
		case "type":
			assertAllowedKeys(value, ["type", "text"], context);
			requireString(value, "text", context);
			return;
		default:
			throw new Error(`${context} has unsupported action type ${value.type}`);
	}
}

function validateToolCallProviderMetadata(value: unknown, context: string): void {
	if (!isRecord(value) || value.type !== "computer") throw new Error(`${context} must be a computer metadata object`);
	assertAllowedKeys(value, ["type", "providerItemId", "actions", "pendingSafetyChecks"], context);
	requireString(value, "providerItemId", context);
	if (!Array.isArray(value.actions)) throw new Error(`${context}.actions must be an array`);
	for (const [index, action] of value.actions.entries())
		validateComputerAction(action, `${context}.actions[${index}]`);
	if (!Array.isArray(value.pendingSafetyChecks)) throw new Error(`${context}.pendingSafetyChecks must be an array`);
	for (const [index, check] of value.pendingSafetyChecks.entries())
		validateComputerSafetyCheck(check, `${context}.pendingSafetyChecks[${index}]`);
}

function validateAssistantContent(value: unknown, context: string): void {
	if (!Array.isArray(value)) throw new Error(`${context} assistant content must be an array`);
	for (const [index, block] of value.entries()) {
		const blockContext = `${context} content[${index}]`;
		if (!isRecord(block) || typeof block.type !== "string") throw new Error(`${blockContext} is invalid`);
		switch (block.type) {
			case "text":
				assertAllowedKeys(block, ["type", "text", "textSignature"], blockContext);
				requireString(block, "text", blockContext);
				optionalString(block, "textSignature", blockContext);
				break;
			case "thinking":
				assertAllowedKeys(block, ["type", "thinking", "thinkingSignature", "itemId"], blockContext);
				requireString(block, "thinking", blockContext);
				optionalString(block, "thinkingSignature", blockContext);
				optionalString(block, "itemId", blockContext);
				break;
			case "redactedThinking":
				assertAllowedKeys(block, ["type", "data"], blockContext);
				requireString(block, "data", blockContext);
				break;
			case "toolCall":
				assertAllowedKeys(
					block,
					[
						"type",
						"id",
						"name",
						"arguments",
						"thoughtSignature",
						"intent",
						"rawBlock",
						"customWireName",
						"providerMetadata",
					],
					blockContext,
				);
				requireNonEmptyString(block, "id", blockContext);
				requireNonEmptyString(block, "name", blockContext);
				if (!isJsonObject(block.arguments)) throw new Error(`${blockContext} arguments must be a JSON object`);
				optionalString(block, "thoughtSignature", blockContext);
				optionalString(block, "intent", blockContext);
				optionalString(block, "rawBlock", blockContext);
				optionalString(block, "customWireName", blockContext);
				if (block.providerMetadata !== undefined)
					validateToolCallProviderMetadata(block.providerMetadata, `${blockContext}.providerMetadata`);
				break;
			case "image":
				validateImageContent(block, blockContext);
				break;
			case "fallback": {
				assertAllowedKeys(block, ["type", "from", "to"], blockContext);
				const from = requireObject(block, "from", blockContext);
				const to = requireObject(block, "to", blockContext);
				assertAllowedKeys(from, ["model"], `${blockContext}.from`);
				assertAllowedKeys(to, ["model"], `${blockContext}.to`);
				requireString(from, "model", `${blockContext}.from`);
				requireString(to, "model", `${blockContext}.to`);
				break;
			}
			case "anthropicServerTool": {
				assertAllowedKeys(block, ["type", "block"], blockContext);
				const serverBlock = requireObject(block, "block", blockContext);
				if (serverBlock.type === "server_tool_use") {
					if (!isJsonValue(serverBlock)) throw new Error(`${blockContext}.block is not JSON`);
					requireString(serverBlock, "id", `${blockContext}.block`);
					if (serverBlock.name !== "web_search") throw new Error(`${blockContext}.block has invalid name`);
					if (serverBlock.input !== undefined && serverBlock.input !== null && !isJsonObject(serverBlock.input))
						throw new Error(`${blockContext}.block has invalid input`);
				} else if (serverBlock.type === "web_search_tool_result") {
					if (!isJsonValue(serverBlock)) throw new Error(`${blockContext}.block is not JSON`);
					requireString(serverBlock, "tool_use_id", `${blockContext}.block`);
					if (serverBlock.content === undefined) throw new Error(`${blockContext}.block requires content`);
				} else {
					throw new Error(`${blockContext}.block has unsupported type`);
				}
				break;
			}
			default:
				throw new Error(`${blockContext} has unsupported type ${block.type}`);
		}
	}
}

function validateToolResultProviderMetadata(value: unknown, context: string): void {
	if (!isRecord(value) || value.type !== "computer") throw new Error(`${context} must be a computer metadata object`);
	assertAllowedKeys(value, ["type", "screenshot", "acknowledgedSafetyChecks"], context);
	const screenshot = requireObject(value, "screenshot", context);
	if (
		screenshot.type === "computer_screenshot" &&
		typeof screenshot.image_url === "string" &&
		screenshot.file_id === undefined
	) {
		assertAllowedKeys(screenshot, ["type", "image_url"], `${context}.screenshot`);
	} else if (
		screenshot.type === "computer_screenshot" &&
		typeof screenshot.file_id === "string" &&
		screenshot.image_url === undefined
	) {
		assertAllowedKeys(screenshot, ["type", "file_id"], `${context}.screenshot`);
	} else {
		throw new Error(`${context}.screenshot is invalid`);
	}
	if (!Array.isArray(value.acknowledgedSafetyChecks))
		throw new Error(`${context}.acknowledgedSafetyChecks must be an array`);
	for (const [index, check] of value.acknowledgedSafetyChecks.entries())
		validateComputerSafetyCheck(check, `${context}.acknowledgedSafetyChecks[${index}]`);
}

function validateToolResultContent(value: unknown, context: string): void {
	if (!Array.isArray(value)) throw new Error(`${context} toolResult content must be an array`);
	for (const [index, block] of value.entries()) {
		const blockContext = `${context} content[${index}]`;
		if (!isRecord(block) || (block.type !== "text" && block.type !== "image"))
			throw new Error(`${blockContext} is invalid`);
		if (block.type === "text") {
			assertAllowedKeys(block, ["type", "text", "textSignature"], blockContext);
			requireString(block, "text", blockContext);
			optionalString(block, "textSignature", blockContext);
		} else {
			validateImageContent(block, blockContext);
		}
	}
}

function validateRange(value: unknown, context: string): void {
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	assertAllowedKeys(value, ["start", "end"], context);
	requireFiniteNumber(value, "start", context);
	requireFiniteNumber(value, "end", context);
}

function validateExecutionMeta(value: unknown, context: string): void {
	if (!isRecord(value)) throw new Error(`${context} must be an object`);
	assertAllowedKeys(value, ["truncation", "source", "diagnostics", "limits"], context);
	const truncation = optionalObject(value, "truncation", context);
	if (truncation) {
		assertAllowedKeys(
			truncation,
			[
				"direction",
				"truncatedBy",
				"totalLines",
				"totalBytes",
				"outputLines",
				"outputBytes",
				"maxBytes",
				"shownRange",
				"headRange",
				"tailRange",
				"elidedBytes",
				"elidedLines",
				"artifactId",
				"nextOffset",
			],
			`${context}.truncation`,
		);
		if (!["head", "tail", "middle"].includes(truncation.direction as string))
			throw new Error(`${context}.truncation has invalid direction`);
		if (!["lines", "bytes", "middle"].includes(truncation.truncatedBy as string))
			throw new Error(`${context}.truncation has invalid truncatedBy`);
		for (const key of ["totalLines", "totalBytes", "outputLines", "outputBytes"] as const)
			requireFiniteNumber(truncation, key, `${context}.truncation`);
		for (const key of ["maxBytes", "elidedBytes", "elidedLines", "nextOffset"] as const)
			optionalFiniteNumber(truncation, key, `${context}.truncation`);
		for (const key of ["shownRange", "headRange", "tailRange"] as const)
			if (truncation[key] !== undefined) validateRange(truncation[key], `${context}.truncation.${key}`);
		optionalString(truncation, "artifactId", `${context}.truncation`);
	}
	const source = optionalObject(value, "source", context);
	if (source) {
		assertAllowedKeys(source, ["type", "value"], `${context}.source`);
		if (!["path", "url", "internal"].includes(source.type as string))
			throw new Error(`${context}.source has invalid type`);
		requireString(source, "value", `${context}.source`);
	}
	const diagnostics = optionalObject(value, "diagnostics", context);
	if (diagnostics) {
		assertAllowedKeys(diagnostics, ["summary", "messages"], `${context}.diagnostics`);
		requireString(diagnostics, "summary", `${context}.diagnostics`);
		requireStringArray(diagnostics, "messages", `${context}.diagnostics`);
	}
	const limits = optionalObject(value, "limits", context);
	if (limits) {
		assertAllowedKeys(limits, ["matchLimit", "resultLimit", "headLimit", "columnTruncated"], `${context}.limits`);
		for (const key of ["matchLimit", "resultLimit", "headLimit"] as const) {
			const limit = optionalObject(limits, key, `${context}.limits`);
			if (limit) {
				assertAllowedKeys(limit, ["reached", "suggestion"], `${context}.limits.${key}`);
				requireFiniteNumber(limit, "reached", `${context}.limits.${key}`);
				requireFiniteNumber(limit, "suggestion", `${context}.limits.${key}`);
			}
		}
		const column = optionalObject(limits, "columnTruncated", `${context}.limits`);
		if (column) {
			assertAllowedKeys(column, ["maxColumn"], `${context}.limits.columnTruncated`);
			requireFiniteNumber(column, "maxColumn", `${context}.limits.columnTruncated`);
		}
	}
}

function validateExecutionMessage(message: Record<string, unknown>, context: string): void {
	requireString(message, "output", context);
	optionalFiniteNumber(message, "exitCode", context);
	requireBoolean(message, "cancelled", context);
	requireBoolean(message, "truncated", context);
	if (message.meta !== undefined) validateExecutionMeta(message.meta, `${context}.meta`);
	optionalBoolean(message, "excludeFromContext", context);
}

function validateFileMention(message: Record<string, unknown>, context: string): void {
	assertAllowedKeys(message, ["role", "files", "timestamp"], context);
	if (!Array.isArray(message.files)) throw new Error(`${context} files must be an array`);
	for (const [index, file] of message.files.entries()) {
		const fileContext = `${context}.files[${index}]`;
		if (!isRecord(file)) throw new Error(`${fileContext} must be an object`);
		assertAllowedKeys(file, ["path", "content", "lineCount", "byteSize", "skippedReason", "image"], fileContext);
		requireString(file, "path", fileContext);
		requireString(file, "content", fileContext);
		for (const key of ["lineCount", "byteSize"] as const) {
			if (
				file[key] !== undefined &&
				(typeof file[key] !== "number" || !Number.isSafeInteger(file[key]) || file[key] < 0)
			)
				throw new Error(`${fileContext}.${key} must be a non-negative integer`);
		}
		if (file.skippedReason !== undefined && file.skippedReason !== "tooLarge" && file.skippedReason !== "binary")
			throw new Error(`${fileContext} skippedReason is invalid`);
		if (file.image !== undefined) {
			if (!isRecord(file.image) || file.image.type !== "image")
				throw new Error(`${fileContext}.image must be an image object`);
			validateImageContent(file.image, `${fileContext}.image`);
		}
	}
}

function validateMessage(message: Record<string, unknown>, context: string): void {
	const role = requireString(message, "role", context);
	if (MESSAGE_ROLES[role] !== true) throw new Error(`${context} has unsupported message role ${role}`);
	requireFiniteNumber(message, "timestamp", context);
	if (role === "user" || role === "developer") {
		assertAllowedKeys(
			message,
			role === "user"
				? ["role", "content", "synthetic", "steering", "attribution", "providerPayload", "timestamp"]
				: ["role", "content", "attribution", "providerPayload", "timestamp"],
			context,
		);
		validateTextImageContent(message.content, context);
		optionalBoolean(message, "synthetic", context);
		optionalBoolean(message, "steering", context);
		if (message.attribution !== undefined && message.attribution !== "user" && message.attribution !== "agent")
			throw new Error(`${context} attribution is invalid`);
		if (message.providerPayload !== undefined)
			validateProviderPayload(message.providerPayload, `${context}.providerPayload`);
		return;
	}
	if (role === "assistant") {
		assertAllowedKeys(
			message,
			[
				"role",
				"content",
				"api",
				"provider",
				"model",
				"contextSnapshot",
				"retryRecovery",
				"responseId",
				"upstreamProvider",
				"usage",
				"stopReason",
				"stopDetails",
				"errorMessage",
				"toolCallAbortMessages",
				"errorStatus",
				"errorId",
				"disabledFeatures",
				"providerPayload",
				"timestamp",
				"duration",
				"ttft",
			],
			context,
		);
		requireString(message, "api", context);
		requireString(message, "provider", context);
		requireString(message, "model", context);
		validateAssistantContent(message.content, context);
		const usage = requireObject(message, "usage", context);
		validateUsage(usage, `${context}.usage`);
		const stopReason = requireString(message, "stopReason", context);
		if (STOP_REASONS[stopReason] !== true) throw new Error(`${context} has invalid stopReason`);
		if (message.contextSnapshot !== undefined)
			validateContextSnapshot(requireObject(message, "contextSnapshot", context), `${context}.contextSnapshot`);
		if (message.retryRecovery !== undefined)
			validateRetryRecovery(requireObject(message, "retryRecovery", context), `${context}.retryRecovery`);
		optionalString(message, "responseId", context);
		optionalString(message, "upstreamProvider", context);
		optionalString(message, "errorMessage", context);
		if (message.toolCallAbortMessages !== undefined) {
			const abortMessages = requireObject(message, "toolCallAbortMessages", context);
			for (const [key, value] of Object.entries(abortMessages))
				if (typeof value !== "string") throw new Error(`${context}.toolCallAbortMessages.${key} must be a string`);
		}
		optionalFiniteNumber(message, "errorStatus", context);
		optionalFiniteNumber(message, "errorId", context);
		if (message.disabledFeatures !== undefined) requireStringArray(message, "disabledFeatures", context);
		if (message.stopDetails !== undefined) validateStopDetails(message.stopDetails, `${context}.stopDetails`);
		if (message.providerPayload !== undefined)
			validateProviderPayload(message.providerPayload, `${context}.providerPayload`);
		optionalFiniteNumber(message, "duration", context);
		optionalFiniteNumber(message, "ttft", context);
		return;
	}
	if (role === "toolResult") {
		assertAllowedKeys(
			message,
			[
				"role",
				"toolCallId",
				"toolName",
				"content",
				"details",
				"isError",
				"attribution",
				"prunedAt",
				"providerMetadata",
				"useless",
				"timestamp",
			],
			context,
		);
		requireNonEmptyString(message, "toolCallId", context);
		requireNonEmptyString(message, "toolName", context);
		validateToolResultContent(message.content, context);
		requireBoolean(message, "isError", context);
		optionalJson(message, "details", context);
		if (message.attribution !== undefined && message.attribution !== "user" && message.attribution !== "agent")
			throw new Error(`${context} attribution is invalid`);
		optionalFiniteNumber(message, "prunedAt", context);
		optionalBoolean(message, "useless", context);
		if (message.providerMetadata !== undefined)
			validateToolResultProviderMetadata(message.providerMetadata, `${context}.providerMetadata`);
		return;
	}
	if (role === "custom" || role === "hookMessage") {
		assertAllowedKeys(
			message,
			["role", "customType", "content", "display", "details", "attribution", "timestamp"],
			context,
		);
		requireString(message, "customType", context);
		validateTextImageContent(message.content, context);
		requireBoolean(message, "display", context);
		optionalJson(message, "details", context);
		if (message.attribution !== undefined && message.attribution !== "user" && message.attribution !== "agent")
			throw new Error(`${context} attribution is invalid`);
		return;
	}
	if (role === "branchSummary") {
		assertAllowedKeys(message, ["role", "summary", "fromId", "timestamp"], context);
		requireString(message, "summary", context);
		requireString(message, "fromId", context);
		return;
	}
	if (role === "compactionSummary") {
		assertAllowedKeys(
			message,
			[
				"role",
				"summary",
				"shortSummary",
				"tokensBefore",
				"providerPayload",
				"blocks",
				"images",
				"warning",
				"timestamp",
			],
			context,
		);
		requireString(message, "summary", context);
		optionalString(message, "shortSummary", context);
		requireFiniteNumber(message, "tokensBefore", context);
		if (message.providerPayload !== undefined)
			validateProviderPayload(message.providerPayload, `${context}.providerPayload`);
		for (const key of ["blocks", "images"] as const) {
			if (message[key] === undefined) continue;
			if (!Array.isArray(message[key])) throw new Error(`${context}.${key} must be an array`);
			validateTextImageContent(message[key], `${context}.${key}`);
		}
		optionalString(message, "warning", context);
		return;
	}
	if (role === "bashExecution" || role === "pythonExecution") {
		assertAllowedKeys(
			message,
			role === "bashExecution"
				? [
						"role",
						"command",
						"output",
						"exitCode",
						"cancelled",
						"truncated",
						"meta",
						"excludeFromContext",
						"timestamp",
					]
				: [
						"role",
						"code",
						"output",
						"exitCode",
						"cancelled",
						"truncated",
						"meta",
						"excludeFromContext",
						"timestamp",
					],
			context,
		);
		requireString(message, role === "bashExecution" ? "command" : "code", context);
		validateExecutionMessage(message, context);
		return;
	}
	validateFileMention(message, context);
}

function validateHeader(value: OmpJsonObject): OmpSessionHeader {
	assertAllowedKeys(
		value,
		[
			"type",
			"version",
			"id",
			"timestamp",
			"cwd",
			"title",
			"titleSource",
			"additionalDirectories",
			"parentSession",
			"previousSessionFiles",
			"providerPromptCacheKey",
		],
		"OMP session header",
	);
	if (value.type !== "session" || value.version !== 3)
		throw new Error("OMP session must begin with a version 3 session header");
	const header: OmpSessionHeader = {
		type: "session",
		version: 3,
		id: requireString(value, "id", "OMP session header"),
		timestamp: requireString(value, "timestamp", "OMP session header"),
		cwd: requireString(value, "cwd", "OMP session header"),
	};
	optionalString(value, "title", "OMP session header");
	optionalString(value, "parentSession", "OMP session header");
	optionalString(value, "providerPromptCacheKey", "OMP session header");
	for (const key of ["additionalDirectories", "previousSessionFiles"] as const) {
		if (
			value[key] !== undefined &&
			(!Array.isArray(value[key]) || !value[key].every(item => typeof item === "string"))
		)
			throw new Error(`OMP session header ${key} must be an array of strings`);
	}
	if (value.titleSource !== undefined && value.titleSource !== "auto" && value.titleSource !== "user")
		throw new Error("OMP session header titleSource is invalid");
	return {
		...header,
		...(typeof value.title === "string" ? { title: value.title } : {}),
		...(value.titleSource === "auto" || value.titleSource === "user" ? { titleSource: value.titleSource } : {}),
		...(Array.isArray(value.additionalDirectories)
			? { additionalDirectories: value.additionalDirectories as string[] }
			: {}),
		...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}),
		...(Array.isArray(value.previousSessionFiles)
			? { previousSessionFiles: value.previousSessionFiles as string[] }
			: {}),
		...(typeof value.providerPromptCacheKey === "string"
			? { providerPromptCacheKey: value.providerPromptCacheKey }
			: {}),
	};
}

function validateBaseEntry(value: OmpJsonObject, context: string): void {
	if (typeof value.type !== "string" || typeof value.id !== "string" || typeof value.timestamp !== "string")
		throw new Error(`${context} is missing a valid type, id, or timestamp`);
	if (value.parentId !== null && typeof value.parentId !== "string")
		throw new Error(`${context} has invalid parentId`);
}

function validateKnownEntry(value: OmpJsonObject): void {
	const context = `OMP ${String(value.type)} entry ${String(value.id)}`;
	const baseKeys = ["type", "id", "parentId", "timestamp"];
	switch (value.type) {
		case "message":
			assertAllowedKeys(value, [...baseKeys, "message"], context);
			if (!isRecord(value.message)) throw new Error(`${context} requires a message object`);
			validateMessage(value.message, `${context}.message`);
			return;
		case "thinking_level_change":
			assertAllowedKeys(value, [...baseKeys, "thinkingLevel", "configured"], context);
			if (
				value.thinkingLevel !== undefined &&
				value.thinkingLevel !== null &&
				typeof value.thinkingLevel !== "string"
			)
				throw new Error(`${context} has invalid thinkingLevel`);
			if (value.configured !== undefined && value.configured !== null && typeof value.configured !== "string")
				throw new Error(`${context} has invalid configured`);
			return;
		case "model_change":
			assertAllowedKeys(value, [...baseKeys, "model", "role", "resolvedModelIsFallback"], context);
			requireString(value, "model", context);
			optionalString(value, "role", context);
			optionalBoolean(value, "resolvedModelIsFallback", context);
			return;
		case "service_tier_change": {
			assertAllowedKeys(value, [...baseKeys, "serviceTier"], context);
			if (value.serviceTier === null) return;
			const tiers = requireObject(value, "serviceTier", context);
			assertAllowedKeys(tiers, ["openai", "anthropic", "google"], `${context}.serviceTier`);
			for (const [family, tier] of Object.entries(tiers)) {
				if (typeof tier !== "string" || SERVICE_TIERS[tier] !== true)
					throw new Error(`${context} has invalid serviceTier.${family}`);
			}
			return;
		}
		case "compaction":
			assertAllowedKeys(
				value,
				[
					...baseKeys,
					"summary",
					"shortSummary",
					"firstKeptEntryId",
					"tokensBefore",
					"details",
					"preserveData",
					"fromExtension",
					"warning",
				],
				context,
			);
			requireString(value, "summary", context);
			optionalString(value, "shortSummary", context);
			requireString(value, "firstKeptEntryId", context);
			requireFiniteNumber(value, "tokensBefore", context);
			optionalJson(value, "details", context);
			if (value.preserveData !== undefined && !isJsonObject(value.preserveData))
				throw new Error(`${context} preserveData must be an object`);
			optionalBoolean(value, "fromExtension", context);
			optionalString(value, "warning", context);
			return;
		case "branch_summary":
			assertAllowedKeys(value, [...baseKeys, "fromId", "summary", "details", "fromExtension"], context);
			requireString(value, "fromId", context);
			requireString(value, "summary", context);
			optionalJson(value, "details", context);
			optionalBoolean(value, "fromExtension", context);
			return;
		case "reset_boundary":
			assertAllowedKeys(value, baseKeys, context);
			return;
		case "custom":
			assertAllowedKeys(value, [...baseKeys, "customType", "data"], context);
			requireString(value, "customType", context);
			optionalJson(value, "data", context);
			return;
		case "custom_message":
			assertAllowedKeys(value, [...baseKeys, "customType", "content", "details", "display", "attribution"], context);
			requireString(value, "customType", context);
			validateTextImageContent(value.content, context);
			requireBoolean(value, "display", context);
			optionalJson(value, "details", context);
			if (value.attribution !== undefined && value.attribution !== "user" && value.attribution !== "agent")
				throw new Error(`${context} attribution is invalid`);
			return;
		case "label":
			assertAllowedKeys(value, [...baseKeys, "targetId", "label"], context);
			requireString(value, "targetId", context);
			optionalString(value, "label", context);
			return;
		case "title_change":
			assertAllowedKeys(value, [...baseKeys, "title", "previousTitle", "source", "trigger"], context);
			requireString(value, "title", context);
			if (value.source !== "auto" && value.source !== "user") throw new Error(`${context} source is invalid`);
			optionalString(value, "previousTitle", context);
			optionalString(value, "trigger", context);
			return;
		case "ttsr_injection":
			assertAllowedKeys(value, [...baseKeys, "injectedRules"], context);
			requireStringArray(value, "injectedRules", context);
			return;
		case "credential_pin":
			assertAllowedKeys(value, [...baseKeys, "provider", "hash"], context);
			requireString(value, "provider", context);
			requireString(value, "hash", context);
			return;
		case "session_init":
			assertAllowedKeys(
				value,
				[
					...baseKeys,
					"systemPrompt",
					"task",
					"tools",
					"agent",
					"modelRole",
					"resolvedModel",
					"readOnly",
					"outputSchema",
					"outputSchemaMode",
					"restrictToolNames",
					"spawns",
					"readSummarize",
				],
				context,
			);
			requireString(value, "systemPrompt", context);
			requireString(value, "task", context);
			requireStringArray(value, "tools", context);
			for (const key of ["agent", "modelRole", "resolvedModel", "spawns"] as const)
				optionalString(value, key, context);
			for (const key of ["readOnly", "restrictToolNames", "readSummarize"] as const)
				optionalBoolean(value, key, context);
			optionalJson(value, "outputSchema", context);
			if (
				value.outputSchemaMode !== undefined &&
				value.outputSchemaMode !== "permissive" &&
				value.outputSchemaMode !== "strict"
			)
				throw new Error(`${context} outputSchemaMode is invalid`);
			return;
		case "mode_change":
			assertAllowedKeys(value, [...baseKeys, "mode", "data"], context);
			requireString(value, "mode", context);
			if (value.data !== undefined && !isJsonObject(value.data))
				throw new Error(`${context} data must be an object`);
			return;
	}
}

function parsePhysicalLines(bytes: Uint8Array): PhysicalLine[] {
	const lines: PhysicalLine[] = [];
	let start = 0;
	for (let index = 0; index <= bytes.byteLength; index++) {
		if (index !== bytes.byteLength && bytes[index] !== 0x0a) continue;
		const rawBytes = bytes.slice(start, index);
		const parseBytes = rawBytes[rawBytes.length - 1] === 0x0d ? rawBytes.slice(0, -1) : rawBytes;
		const text = textDecoder.decode(parseBytes);
		start = index + 1;
		if (text.trim().length === 0) continue;
		if (hasDuplicateJsonKeys(text)) throw new Error("OMP session contains duplicate JSON object keys");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("OMP session contains malformed JSONL");
		}
		if (!isJsonObject(parsed)) throw new Error("OMP session JSONL entries must be objects");
		lines.push({ bytes: rawBytes, text, value: parsed });
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
	let found: Span | undefined;
	for (index += 1; index < text.length; ) {
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === "}") return found;
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
		if (key === property) found = { start, end };
		index = end;
		while (/\s/.test(text[index] ?? "")) index++;
		if (text[index] === ",") index++;
		else if (text[index] === "}") return found;
	}
	return found;
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

function validatePhysicalTree(entries: readonly OmpJsonObject[]): void {
	if (entries.length === 0) return;
	const seen = new Set<string>();
	const allIds = new Set(entries.map(entry => String(entry.id)));
	let roots = 0;
	for (const [index, entry] of entries.entries()) {
		const id = entry.id as string;
		if (seen.has(id)) throw new Error(`OMP session contains duplicate entry id ${id}`);
		if (entry.parentId === null) {
			roots++;
			if (index !== 0) throw new Error("OMP session must contain exactly one root entry");
		} else if (!allIds.has(entry.parentId as string)) {
			throw new Error(`OMP session entry ${id} has a missing parent`);
		} else if (!seen.has(entry.parentId as string)) {
			throw new Error(`OMP session entry ${id} has a forward parent`);
		}
		seen.add(id);
	}
	if (roots !== 1) throw new Error("OMP session must contain exactly one root entry");
}

function casRefValue(ref: CasRef): JsonValue {
	return { hash: ref.hash, ...(ref.byteLength === undefined ? {} : { byteLength: ref.byteLength }) };
}

async function putText(cas: FileCas, text: string): Promise<CasRef> {
	return cas.put(textEncoder.encode(text));
}
async function copyBlobRefs(
	value: unknown,
	blobDir: string,
	cas: FileCas,
	losses: SessionLoss[],
	seen: Set<string>,
	key?: string,
): Promise<void> {
	const copyRef = async (candidate: unknown): Promise<void> => {
		if (typeof candidate !== "string") return;
		const match = BLOB_REF_PATTERN.exec(candidate);
		if (match === null) return;
		const hash = match[1];
		if (seen.has(hash)) return;
		seen.add(hash);
		const file = Bun.file(join(blobDir, hash));
		const data = (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
		if (data === null) {
			losses.push(createLoss("blob_unavailable", `OMP blob is unavailable: ${hash}`, undefined, "blob"));
			return;
		}
		if (FileCas.hash(data) !== hash) throw new Error(`OMP blob hash verification failed: ${hash}`);
		await cas.put(data);
	};
	if (Array.isArray(value)) {
		for (const item of value) await copyBlobRefs(item, blobDir, cas, losses, seen, key);
		return;
	}
	if (!isRecord(value)) return;
	const imagePayload =
		typeof value.data === "string" &&
		(value.type === "image" ||
			(typeof value.mimeType === "string" && value.mimeType.toLowerCase().startsWith("image/")));
	if (imagePayload && ((key === "content" && value.type === "image") || key === "images")) await copyRef(value.data);
	if (value.type === "image_generation_call" && typeof value.result === "string") await copyRef(value.result);
	if (typeof value.image_url === "string") await copyRef(value.image_url);
	for (const [childKey, item] of Object.entries(value)) await copyBlobRefs(item, blobDir, cas, losses, seen, childKey);
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

function bridgeDigest(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

function bridgeCasRef(value: unknown, context: string): CasRef {
	if (!isJsonObject(value) || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash))
		throw new Error(`${context} requires a lowercase SHA-256 CAS ref`);
	if (
		value.byteLength !== undefined &&
		(typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0)
	)
		throw new Error(`${context} has invalid byteLength`);
	assertAllowedKeys(value, ["hash", "byteLength"], context);
	return { hash: value.hash, ...(value.byteLength === undefined ? {} : { byteLength: value.byteLength }) };
}
function parseBridgeDetails(value: unknown): BridgeDetails {
	if (!isJsonObject(value)) throw new Error("OMP bridge marker data must be an object");
	assertAllowedKeys(
		value,
		["version", "activeLeafId", "header", "nativeIdMap", "lossLedger", "provenance", "tails"],
		"OMP bridge marker data",
	);
	if (value.version !== 1) throw new Error("OMP bridge marker data has unsupported version");
	if (typeof value.activeLeafId !== "string" && value.activeLeafId !== null)
		throw new Error("OMP bridge marker data has invalid activeLeafId");
	const headerValue = value.header;
	if (!isJsonObject(headerValue)) throw new Error("OMP bridge marker data requires header");
	assertAllowedKeys(headerValue, ["sourceRef"], "OMP bridge marker header");
	const sourceRef =
		headerValue.sourceRef === undefined ? undefined : bridgeCasRef(headerValue.sourceRef, "OMP bridge sourceRef");
	const nativeValue = value.nativeIdMap;
	const provenanceValue = value.provenance;
	if (!isJsonObject(nativeValue) || !isJsonObject(provenanceValue))
		throw new Error("OMP bridge marker data requires nativeIdMap and provenance");
	const nativeIdMap = Object.create(null) as SessionSpecV1["nativeIdMap"];
	const usedOmpIds = new Set<string>();
	const usedPrimeIds = new Set<string>();
	for (const [canonicalId, pairValue] of Object.entries(nativeValue)) {
		if (!isJsonObject(pairValue)) throw new Error(`OMP bridge nativeIdMap.${canonicalId} must be an object`);
		assertAllowedKeys(pairValue, ["prime", "omp"], `OMP bridge nativeIdMap.${canonicalId}`);
		if (typeof pairValue.omp !== "string" || pairValue.omp.length === 0)
			throw new Error(`OMP bridge nativeIdMap.${canonicalId} requires omp`);
		if (usedOmpIds.has(pairValue.omp))
			throw new Error(`OMP bridge nativeIdMap has duplicate omp ID ${pairValue.omp}`);
		usedOmpIds.add(pairValue.omp);
		if (pairValue.prime !== undefined && (typeof pairValue.prime !== "string" || pairValue.prime.length === 0))
			throw new Error(`OMP bridge nativeIdMap.${canonicalId} has invalid prime`);
		if (typeof pairValue.prime === "string") {
			if (usedPrimeIds.has(pairValue.prime))
				throw new Error(`OMP bridge nativeIdMap has duplicate prime ID ${pairValue.prime}`);
			usedPrimeIds.add(pairValue.prime);
		}
		nativeIdMap[canonicalId] = {
			omp: pairValue.omp,
			...(pairValue.prime === undefined ? {} : { prime: pairValue.prime }),
		};
	}
	let lossLedger: SessionLoss[];
	try {
		lossLedger = validateLossLedger(value.lossLedger);
	} catch (error) {
		throw new Error(`OMP bridge lossLedger is malformed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const provenance = Object.create(null) as BridgeDetails["provenance"];
	for (const [nodeId, item] of Object.entries(provenanceValue)) {
		if (!isJsonObject(item)) throw new Error(`OMP bridge provenance.${nodeId} must be an object`);
		assertAllowedKeys(
			item,
			["role", "thinkingRef", "providerPayloadRef", "metadata", "toolPairs"],
			`OMP bridge provenance.${nodeId}`,
		);
		if (typeof item.role !== "string" || !Object.hasOwn(CANONICAL_ROLES, item.role))
			throw new Error(`OMP bridge provenance.${nodeId} has invalid role`);
		if (!Array.isArray(item.toolPairs)) throw new Error(`OMP bridge provenance.${nodeId} requires toolPairs`);
		const thinkingRef =
			item.thinkingRef === undefined
				? undefined
				: bridgeCasRef(item.thinkingRef, `OMP bridge provenance.${nodeId}.thinkingRef`);
		const providerPayloadRef =
			item.providerPayloadRef === undefined
				? undefined
				: bridgeCasRef(item.providerPayloadRef, `OMP bridge provenance.${nodeId}.providerPayloadRef`);
		let metadata: BridgeDetails["provenance"][string]["metadata"];
		if (item.metadata !== undefined) {
			if (!isJsonObject(item.metadata))
				throw new Error(`OMP bridge provenance.${nodeId}.metadata must be an object`);
			assertAllowedKeys(
				item.metadata,
				["sourceLineRef", "sourceMessageRef", "titleSlotRef"],
				`OMP bridge provenance.${nodeId}.metadata`,
			);
			const sourceLineRef =
				item.metadata.sourceLineRef === undefined
					? undefined
					: bridgeCasRef(item.metadata.sourceLineRef, `OMP bridge provenance.${nodeId}.sourceLineRef`);
			const sourceMessageRef =
				item.metadata.sourceMessageRef === undefined
					? undefined
					: bridgeCasRef(item.metadata.sourceMessageRef, `OMP bridge provenance.${nodeId}.sourceMessageRef`);
			const titleSlotRef =
				item.metadata.titleSlotRef === undefined
					? undefined
					: bridgeCasRef(item.metadata.titleSlotRef, `OMP bridge provenance.${nodeId}.titleSlotRef`);
			metadata = {
				...(sourceLineRef === undefined ? {} : { sourceLineRef }),
				...(sourceMessageRef === undefined ? {} : { sourceMessageRef }),
				...(titleSlotRef === undefined ? {} : { titleSlotRef }),
			};
		}
		const toolPairs: BridgePairProvenance[] = [];
		const seenPairIndexes = new Set<number>();
		for (const [index, pairValue] of item.toolPairs.entries()) {
			if (!isJsonObject(pairValue))
				throw new Error(`OMP bridge provenance.${nodeId}.toolPairs[${index}] must be an object`);
			assertAllowedKeys(
				pairValue,
				["pairIndex", "toolName", "callId", "argsSnapshot", "originalCallRef", "synthesizedCallRef", "resultRef"],
				`OMP bridge provenance.${nodeId}.toolPairs[${index}]`,
			);
			if (
				typeof pairValue.pairIndex !== "number" ||
				!Number.isSafeInteger(pairValue.pairIndex) ||
				pairValue.pairIndex < 0 ||
				pairValue.pairIndex !== index
			)
				throw new Error(`OMP bridge provenance.${nodeId}.toolPairs[${index}] has ambiguous pairIndex`);
			if (seenPairIndexes.has(pairValue.pairIndex))
				throw new Error(`OMP bridge provenance.${nodeId} has duplicate pairIndex`);
			seenPairIndexes.add(pairValue.pairIndex);
			if (
				typeof pairValue.toolName !== "string" ||
				typeof pairValue.callId !== "string" ||
				!isJsonValue(pairValue.argsSnapshot)
			)
				throw new Error(`OMP bridge provenance.${nodeId}.toolPairs[${index}] is malformed`);
			const originalCallRef =
				pairValue.originalCallRef === undefined
					? undefined
					: bridgeCasRef(pairValue.originalCallRef, `OMP bridge provenance.${nodeId}.originalCallRef`);
			const synthesizedCallRef =
				pairValue.synthesizedCallRef === undefined
					? undefined
					: bridgeCasRef(pairValue.synthesizedCallRef, `OMP bridge provenance.${nodeId}.synthesizedCallRef`);
			const resultRef =
				pairValue.resultRef === undefined
					? undefined
					: bridgeCasRef(pairValue.resultRef, `OMP bridge provenance.${nodeId}.resultRef`);
			toolPairs.push({
				pairIndex: pairValue.pairIndex,
				toolName: pairValue.toolName,
				callId: pairValue.callId,
				argsSnapshot: pairValue.argsSnapshot,
				...(originalCallRef === undefined ? {} : { originalCallRef }),
				...(synthesizedCallRef === undefined ? {} : { synthesizedCallRef }),
				...(resultRef === undefined ? {} : { resultRef }),
			});
		}
		provenance[nodeId] = {
			role: item.role as SessionSpecNode["role"],
			...(thinkingRef === undefined ? {} : { thinkingRef }),
			...(providerPayloadRef === undefined ? {} : { providerPayloadRef }),
			...(metadata === undefined ? {} : { metadata }),
			toolPairs,
		};
	}
	const tails: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
	if (value.tails !== undefined) {
		if (!isJsonObject(value.tails)) throw new Error("OMP bridge tails must be an object");
		const seenTailIds = new Set<string>();
		for (const [nodeId, tailValue] of Object.entries(value.tails)) {
			if (!Array.isArray(tailValue) || tailValue.length === 0)
				throw new Error(`OMP bridge tails.${nodeId} must be a non-empty array`);
			const ids: string[] = [];
			for (const [index, id] of tailValue.entries()) {
				if (typeof id !== "string" || id.length === 0 || seenTailIds.has(id))
					throw new Error(`OMP bridge tails.${nodeId}[${index}] has an invalid or duplicate physical ID`);
				seenTailIds.add(id);
				ids.push(id);
			}
			tails[nodeId] = ids;
		}
	}
	const nativeKeys = Object.keys(nativeIdMap).sort();
	const provenanceKeys = Object.keys(provenance).sort();
	if (nativeKeys.length !== provenanceKeys.length || nativeKeys.some((key, index) => key !== provenanceKeys[index]))
		throw new Error("OMP bridge nativeIdMap and provenance must have one-to-one canonical IDs");
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
async function validateBridgeCasRefs(details: BridgeDetails, cas: FileCas): Promise<void> {
	const refs: CasRef[] = [];
	if (details.header.sourceRef !== undefined) refs.push(details.header.sourceRef);
	for (const provenance of Object.values(details.provenance)) {
		for (const ref of [
			provenance.thinkingRef,
			provenance.providerPayloadRef,
			provenance.metadata?.sourceLineRef,
			provenance.metadata?.sourceMessageRef,
			provenance.metadata?.titleSlotRef,
		])
			if (ref !== undefined) refs.push(ref);
		for (const pair of provenance.toolPairs)
			for (const ref of [pair.originalCallRef, pair.synthesizedCallRef, pair.resultRef])
				if (ref !== undefined) refs.push(ref);
	}
	for (const ref of refs) await cas.read(ref);
}

function contentFor(entry: OmpJsonObject, message: Record<string, unknown> | undefined): JsonValue {
	if (message?.content !== undefined && isJsonValue(message.content)) return message.content;
	if (message !== undefined && isJsonValue(message)) return message;
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary as JsonValue;
	if (entry.type === "custom") return (entry.data as JsonValue | undefined) ?? entry;
	if (entry.type === "custom_message") return entry.content as JsonValue;
	return entry;
}

function roleFor(entry: OmpJsonObject, message: Record<string, unknown> | undefined): SessionSpecNode["role"] {
	if (entry.type === "compaction") return "compaction";
	if (entry.type === "custom_message" || entry.type === "custom") return "custom";
	if (entry.type === "branch_summary") return "custom";
	if (entry.type !== "message") return "custom";
	if (message?.role === "user") return "user";
	if (message?.role === "developer") return "system";
	if (message?.role === "assistant" || message?.role === "toolResult") return message.role;
	return "custom";
}
function customMetadata(entry: OmpJsonObject, message: Record<string, unknown> | undefined): Record<string, JsonValue> {
	const metadata: Record<string, JsonValue> = {};
	const copy = (source: Record<string, unknown>, keys: readonly string[]): void => {
		for (const key of keys) {
			const value = source[key];
			if (value !== undefined && isJsonValue(value)) metadata[key] = value;
		}
	};
	if (entry.type === "custom" || entry.type === "custom_message")
		copy(entry, ["customType", "display", "details", "attribution"]);
	if (entry.type === "compaction") copy(entry, ["details", "preserveData", "fromExtension", "warning"]);
	if (entry.type === "branch_summary") copy(entry, ["details", "fromExtension"]);
	if (message?.role === "custom" || message?.role === "hookMessage")
		copy(message, ["customType", "display", "details", "attribution"]);
	else if (message?.role === "toolResult") copy(message, ["details", "isError", "attribution", "prunedAt", "useless"]);
	else if (message?.role === "user") copy(message, ["attribution", "synthetic", "steering"]);
	return metadata;
}

export async function readOmpSession(
	filePath: string,
	cas: FileCas,
	options: OmpReadOptions = {},
): Promise<SessionSpecV1> {
	if (options.trustedBridgeDigest !== undefined && !/^[0-9a-f]{64}$/.test(options.trustedBridgeDigest))
		throw new Error("trustedBridgeDigest must be a lowercase SHA-256 hex digest");
	const fileBytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	const titleLineEnd = fileBytes.indexOf(0x0a);
	let titleSlot: OmpSessionTitleSlot | undefined;
	if (titleLineEnd >= 0) {
		const firstText = textDecoder.decode(fileBytes.slice(0, titleLineEnd)).replace(/\r$/, "");
		titleSlot = parseTitleSlotLine(firstText.trim());
		if (titleSlot !== undefined && titleLineEnd + 1 !== 256)
			throw new Error("OMP title slot must be exactly 256 bytes");
	}
	const lines = parsePhysicalLines(fileBytes);
	const jsonLines = titleSlot === undefined ? lines : lines.slice(1);
	if (jsonLines.length === 0) throw new Error("OMP session is empty or has no session header");
	const header = validateHeader(jsonLines[0].value);
	const headerRef = await cas.put(jsonLines[0].bytes);
	const entries = jsonLines.slice(1);
	for (const line of entries) {
		validateBaseEntry(line.value, `OMP ${String(line.value.type)} entry ${String(line.value.id)}`);
		if (KNOWN_ENTRY_TYPES[line.value.type as string] === true) validateKnownEntry(line.value);
	}
	validatePhysicalTree(entries.map(line => line.value));
	let bridge:
		| {
				readonly markerId: string;
				readonly details: BridgeDetails;
				readonly physicalToCanonical: ReadonlyMap<string, string>;
				readonly tailPhysicalToSynthetic: ReadonlyMap<string, string>;
		  }
		| undefined;
	if (options.trustedBridgeDigest !== undefined && bridgeDigest(fileBytes) === options.trustedBridgeDigest) {
		const candidates = entries.filter(
			line => line.value.type === "custom" && line.value.customType === BRIDGE_CUSTOM_TYPE,
		);
		if (candidates.length > 1) throw new Error("OMP bridge metadata is duplicate or ambiguous");
		const candidate = candidates[0];
		if (candidate !== undefined) {
			const details = parseBridgeDetails(candidate.value.data);
			await validateBridgeCasRefs(details, cas);
			const canonicalEntries = entries.filter(line => line !== candidate);
			const physicalIds = new Set(canonicalEntries.map(line => String(line.value.id)));
			const physicalToCanonical = new Map<string, string>();
			for (const [canonicalId, pair] of Object.entries(details.nativeIdMap)) {
				const physicalId = pair.omp;
				if (typeof physicalId !== "string" || !physicalIds.has(physicalId) || physicalToCanonical.has(physicalId))
					throw new Error(`OMP bridge nativeIdMap does not map one-to-one to physical entries`);
				physicalToCanonical.set(physicalId, canonicalId);
			}
			const tailPhysicalIds = new Set<string>();
			for (const [nodeId, tailIds] of Object.entries(details.tails)) {
				if (!Object.hasOwn(details.nativeIdMap, nodeId))
					throw new Error(`OMP bridge tails has unknown node ${nodeId}`);
				const basePhysicalId = details.nativeIdMap[nodeId]?.omp;
				const base = canonicalEntries.find(line => String(line.value.id) === basePhysicalId)?.value;
				if (base === undefined || roleFor(base, isRecord(base.message) ? base.message : undefined) !== "toolResult")
					throw new Error(`OMP bridge tails base ${nodeId} must be a tool result`);
				let previous: string | undefined;
				for (const [index, tailId] of tailIds.entries()) {
					if (
						!physicalIds.has(tailId) ||
						physicalToCanonical.has(tailId) ||
						tailPhysicalIds.has(tailId) ||
						(index > 0 &&
							String(canonicalEntries.find(line => String(line.value.id) === tailId)?.value.parentId) !==
								previous)
					)
						throw new Error(`OMP bridge tails.${nodeId} has an invalid physical chain`);
					const tail = canonicalEntries.find(line => String(line.value.id) === tailId)?.value;
					if (
						tail === undefined ||
						roleFor(tail, isRecord(tail.message) ? tail.message : undefined) !== "toolResult"
					)
						throw new Error(`OMP bridge tails.${nodeId} contains a non-tool result`);
					tailPhysicalIds.add(tailId);
					previous = tailId;
				}
				if (tailIds.length > 0 && String(base.parentId) !== tailIds[tailIds.length - 1])
					throw new Error(`OMP bridge tails.${nodeId} does not terminate at its base`);
			}
			if (
				canonicalEntries.length !== physicalToCanonical.size + tailPhysicalIds.size ||
				canonicalEntries.some(
					line => !physicalToCanonical.has(String(line.value.id)) && !tailPhysicalIds.has(String(line.value.id)),
				)
			)
				throw new Error("OMP bridge nativeIdMap and tails do not cover every physical entry");
			for (const line of canonicalEntries) {
				if (
					line.value.parentId !== null &&
					line.value.parentId !== candidate.value.id &&
					!physicalToCanonical.has(line.value.parentId as string) &&
					!tailPhysicalIds.has(line.value.parentId as string)
				)
					throw new Error(`OMP bridge parent mapping is missing for ${String(line.value.id)}`);
			}
			if (details.activeLeafId !== null && !Object.hasOwn(details.nativeIdMap, details.activeLeafId))
				throw new Error("OMP bridge activeLeafId is not declared in nativeIdMap");
			const tailPhysicalToSynthetic = new Map<string, string>();
			const usedIds = new Set<string>([...Object.keys(details.nativeIdMap), ...physicalIds]);
			for (const [nodeId, tailIds] of Object.entries(details.tails))
				for (const [index, tailId] of tailIds.entries()) {
					let synthetic = `${nodeId}\u0000omp-tail\u0000${index}`;
					while (usedIds.has(synthetic)) synthetic += "\u0000";
					usedIds.add(synthetic);
					tailPhysicalToSynthetic.set(tailId, synthetic);
				}
			bridge = {
				markerId: String(candidate.value.id),
				details,
				physicalToCanonical,
				tailPhysicalToSynthetic,
			};
		}
	}
	const titleSlotRef =
		titleSlot === undefined ? undefined : await cas.put(fileBytes.slice(0, fileBytes.indexOf(0x0a) + 1));
	const losses: SessionLoss[] = [];
	if (titleSlotRef !== undefined && entries.length === 0)
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"OMP title slot has no canonical node metadata target",
				undefined,
				"title",
			),
		);
	for (const key of [
		"titleSource",
		"parentSession",
		"additionalDirectories",
		"previousSessionFiles",
		"providerPromptCacheKey",
	] as const) {
		if (header[key] !== undefined)
			losses.push(
				createLoss(
					"entry_metadata_unrepresentable",
					`OMP header field ${key} is not represented in SessionSpecHeader`,
					undefined,
					"session",
				),
			);
	}
	const blobDir = getBlobsDir(options.ompAgentDir);
	const seenBlobs = new Set<string>();
	const nodes: MutableSessionNode[] = [];
	const nativeIdMap = Object.create(null) as SessionSpecV1["nativeIdMap"];
	if (bridge !== undefined)
		for (const [canonicalId, pair] of Object.entries(bridge.details.nativeIdMap))
			nativeIdMap[canonicalId] = { ...pair };
	for (const line of entries) {
		if (bridge?.markerId === line.value.id) continue;
		const entry = line.value;
		await copyBlobRefs(entry, blobDir, cas, losses, seenBlobs);
		const physicalId = String(entry.id);
		const nodeId =
			bridge?.physicalToCanonical.get(physicalId) ?? bridge?.tailPhysicalToSynthetic.get(physicalId) ?? physicalId;
		const parentId =
			bridge === undefined
				? (entry.parentId as string | null)
				: entry.parentId === null || entry.parentId === bridge.markerId
					? null
					: (bridge.physicalToCanonical.get(entry.parentId as string) ??
						bridge.tailPhysicalToSynthetic.get(entry.parentId as string));
		if (parentId === undefined) throw new Error(`OMP bridge parent mapping is missing for ${physicalId}`);
		const sourceType = String(entry.type);
		const lineRef = await cas.put(line.bytes);
		const message = isRecord(entry.message) ? entry.message : undefined;
		const role = roleFor(entry, message);
		const metadata: Record<string, JsonValue> = {
			sourceType,
			...customMetadata(entry, message),
			sourceLineRef: casRefValue(lineRef),
		};
		if (titleSlotRef !== undefined && nodes.length === 0) metadata.titleSlotRef = casRefValue(titleSlotRef);
		const node: {
			id: string;
			parentId: string | null;
			role: SessionSpecNode["role"];
			content: JsonValue;
			metadata: Record<string, JsonValue>;
			toolPairs?: CanonicalToolPair[];
			thinkingRef?: CasRef;
			providerPayloadRef?: CasRef;
		} = {
			id: nodeId,
			parentId,
			role,
			content: contentFor(entry, message),
			metadata,
		};
		if (bridge === undefined) nativeIdMap[node.id] = { omp: node.id };
		if (KNOWN_ENTRY_TYPES[sourceType] !== true)
			losses.push(createLoss("unsupported_role", `Unsupported OMP entry type: ${sourceType}`, node.id, sourceType));
		if (sourceType === "message" && message !== undefined) {
			const messageSpan = propertySpan(line.text, "message");
			if (messageSpan === undefined)
				throw new Error(`OMP message entry ${node.id} has no recoverable message object`);
			const sourceMessageRef = await putText(cas, line.text.slice(messageSpan.start, messageSpan.end));
			metadata.sourceMessageRef = casRefValue(sourceMessageRef);
			if (typeof message.role === "string") metadata.messageRole = message.role;
			const providerSpan = propertySpan(line.text.slice(messageSpan.start, messageSpan.end), "providerPayload");
			if (providerSpan !== undefined) {
				const absolute = {
					start: messageSpan.start + providerSpan.start,
					end: messageSpan.start + providerSpan.end,
				};
				const providerRef = await putText(cas, line.text.slice(absolute.start, absolute.end));
				node.providerPayloadRef = providerRef;
			}
			if (role === "toolResult") {
				const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
				const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
				if (callId !== undefined && toolName !== undefined)
					node.toolPairs = [{ toolName, callId, argsSnapshot: {}, resultRef: sourceMessageRef }];
			}
			if (role === "assistant") {
				const messageText = line.text.slice(messageSpan.start, messageSpan.end);
				const contentSpan = propertySpan(messageText, "content");
				if (contentSpan !== undefined) {
					const absoluteContent = {
						start: messageSpan.start + contentSpan.start,
						end: messageSpan.start + contentSpan.end,
					};
					const pairs: CanonicalToolPair[] = [];
					const thinkingRefs: JsonValue[] = [];
					for (const blockSpan of arraySpans(line.text, absoluteContent)) {
						const blockText = line.text.slice(blockSpan.start, blockSpan.end);
						let block: unknown;
						try {
							block = JSON.parse(blockText);
						} catch {
							throw new Error(`OMP assistant ${node.id} contains malformed content`);
						}
						if (!isRecord(block)) throw new Error(`OMP assistant ${node.id} contains invalid content block`);
						if (block.type === "toolCall") {
							if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments))
								throw new Error(`OMP assistant ${node.id} has malformed toolCall`);
							const callRef = await putText(cas, blockText);
							pairs.push({
								toolName: block.name,
								callId: block.id,
								argsSnapshot: block.arguments as JsonValue,
								originalCallRef: callRef,
							});
						}
						if (block.type === "thinking") {
							const thinkingRef = await putText(cas, blockText);
							if (node.thinkingRef === undefined) node.thinkingRef = thinkingRef;
							thinkingRefs.push(casRefValue(thinkingRef));
						}
					}
					if (pairs.length > 0) node.toolPairs = pairs;
					if (thinkingRefs.length > 0) metadata.thinkingRefs = thinkingRefs;
				}
			}
		}
		nodes.push(node);
	}
	if (bridge !== undefined && Object.keys(bridge.details.tails).length > 0) {
		const nodeById = new Map(nodes.map(node => [node.id, node]));
		const removed = new Set<string>();
		for (const [nodeId, tailIds] of Object.entries(bridge.details.tails)) {
			const base = nodeById.get(nodeId);
			const synthetic = tailIds
				.map(tailId => {
					const syntheticId = bridge.tailPhysicalToSynthetic.get(tailId);
					return syntheticId === undefined ? undefined : nodeById.get(syntheticId);
				})
				.filter((node): node is MutableSessionNode => node !== undefined);
			if (base === undefined || synthetic.length !== tailIds.length || synthetic.length === 0) continue;
			base.parentId = synthetic[0]!.parentId;
			base.toolPairs = [...synthetic.flatMap(node => node.toolPairs ?? []), ...(base.toolPairs ?? [])];
			for (const node of synthetic) removed.add(node.id);
		}
		if (removed.size > 0) {
			let writeIndex = 0;
			for (const node of nodes) if (!removed.has(node.id)) nodes[writeIndex++] = node;
			nodes.length = writeIndex;
		}
	}
	if (bridge !== undefined) {
		for (const [nodeId, provenance] of Object.entries(bridge.details.provenance)) {
			const node = nodes.find(candidate => candidate.id === nodeId);
			if (node === undefined) continue;
			if (node.metadata === undefined) node.metadata = {};
			const metadata = node.metadata;
			node.role = provenance.role;
			if (provenance.thinkingRef === undefined) delete node.thinkingRef;
			else node.thinkingRef = provenance.thinkingRef;
			if (provenance.providerPayloadRef === undefined) delete node.providerPayloadRef;
			else node.providerPayloadRef = provenance.providerPayloadRef;
			delete metadata.sourceLineRef;
			delete metadata.sourceMessageRef;
			delete metadata.titleSlotRef;
			delete metadata.thinkingRefs;
			if (provenance.metadata?.sourceLineRef !== undefined)
				metadata.sourceLineRef = casRefValue(provenance.metadata.sourceLineRef);
			if (provenance.metadata?.sourceMessageRef !== undefined)
				metadata.sourceMessageRef = casRefValue(provenance.metadata.sourceMessageRef);
			if (provenance.metadata?.titleSlotRef !== undefined)
				metadata.titleSlotRef = casRefValue(provenance.metadata.titleSlotRef);
			node.toolPairs =
				provenance.toolPairs.length === 0
					? undefined
					: provenance.toolPairs.map(pair => ({
							toolName: pair.toolName,
							callId: pair.callId,
							argsSnapshot: pair.argsSnapshot,
							...(pair.originalCallRef === undefined ? {} : { originalCallRef: pair.originalCallRef }),
							...(pair.synthesizedCallRef === undefined ? {} : { synthesizedCallRef: pair.synthesizedCallRef }),
							...(pair.resultRef === undefined ? {} : { resultRef: pair.resultRef }),
						}));
		}
	}
	const spec: SessionSpecV1 = {
		specVersion: 1,
		header: {
			originHarness: "omp",
			sourceSessionId: header.id,
			title: titleSlot?.title ?? header.title ?? basename(filePath),
			cwd: header.cwd,
			createdAt: header.timestamp,
			sourceSchema: "omp-session-v3",
			sourceRef: bridge?.details.header.sourceRef ?? headerRef,
		},
		nodes,
		activeLeafId: bridge?.details.activeLeafId ?? nodes[nodes.length - 1]?.id ?? null,
		nativeIdMap,
		lossLedger: bridge === undefined ? losses : mergeLosses(bridge.details.lossLedger, losses),
	};
	return validateSessionSpec(spec);
}

export type { OmpReadOptions };
