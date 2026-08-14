import { parseLocalAuthRef } from "@oh-my-pi/pi-ai";
import {
	cloneModelSpecV1,
	getModelSpecV1Extension,
	isModelSpecV1SecretBearingKey,
	type JsonObject,
	type JsonValue,
	type ModelSpecV1,
	type ModelSpecV1ExtensionNamespace,
	withModelSpecV1Extension,
} from "@oh-my-pi/pi-catalog";

export interface PrimeModelConfigRecord {
	readonly provider: string;
	readonly id: string;
	readonly authRef?: string;
	readonly supportsTools?: boolean;
	readonly contextWindow?: number | null;
	readonly extensions?: ModelSpecV1["extensions"];
}

export interface OmpRunnableModelConfigRecord {
	readonly provider: string;
	readonly id: string;
	readonly authRef?: string;
	readonly supportsTools?: boolean;
	readonly contextWindow?: number | null;
	readonly extensions?: ModelSpecV1["extensions"];
}

type SourceNamespace = ModelSpecV1ExtensionNamespace;
type SanitizedJson = { readonly kind: "value"; readonly value: JsonValue } | { readonly kind: "omit" };

const KNOWN_FIELDS: Readonly<Record<string, true>> = {
	authRef: true,
	contextWindow: true,
	extensions: true,
	id: true,
	provider: true,
	supportsTools: true,
};
const EXTENSION_NAMESPACES: Readonly<Record<ModelSpecV1ExtensionNamespace, true>> = {
	omp: true,
	prime: true,
};
const LOCATION_OR_COMMAND_FIELD_TERMINALS: Readonly<Record<string, true>> = {
	binary: true,
	cmd: true,
	command: true,
	cwd: true,
	dir: true,
	directory: true,
	executable: true,
	file: true,
	location: true,
	path: true,
};

function fail(source: SourceNamespace, field: string, expectation: string): never {
	throw new TypeError(`Invalid ${source} model record: ${field} must be ${expectation}`);
}

function asRecord(value: unknown, source: SourceNamespace): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(source, "record", "an object");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		fail(source, "record", "a plain object");
	}
	for (const field of Reflect.ownKeys(value)) {
		if (typeof field !== "string") fail(source, "record", "JSON-compatible");
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			fail(source, "record", "JSON-compatible");
		}
		if (field === "__proto__" || field === "constructor" || field === "prototype") {
			fail(source, "record", "free of prototype keys");
		}
	}
	return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
	return Object.hasOwn(record, field);
}

function requiredString(record: Record<string, unknown>, field: string, source: SourceNamespace): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		fail(source, field, "a non-empty string");
	}
	return value;
}

function optionalString(record: Record<string, unknown>, field: string, source: SourceNamespace): string | undefined {
	if (!hasOwn(record, field)) return undefined;
	const value = requiredString(record, field, source);
	if (value.trimStart().toLowerCase().startsWith("!cmd")) fail(source, field, "a non-command reference");
	return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string, source: SourceNamespace): boolean | undefined {
	if (!hasOwn(record, field)) return undefined;
	const value = record[field];
	if (typeof value !== "boolean") {
		fail(source, field, "a boolean");
	}
	return value;
}

function validateAuthRef(authRef: string | undefined, providerId: string): string | undefined {
	if (authRef === undefined) return undefined;
	try {
		parseLocalAuthRef(authRef, providerId);
	} catch {
		throw new TypeError("Invalid model authRef: expected a supported local reference for the model provider");
	}
	return authRef;
}

function optionalContextLength(record: Record<string, unknown>, source: SourceNamespace): number | null | undefined {
	if (!hasOwn(record, "contextWindow")) return undefined;
	const value = record.contextWindow;
	if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
		fail(source, "contextWindow", "a positive integer or null");
	}
	return value;
}

function isUnsafeField(field: string): boolean {
	if (field === "__proto__" || field === "constructor" || field === "prototype") return true;
	if (isModelSpecV1SecretBearingKey(field)) return true;
	const words = field
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const terminal = words.at(-1);
	return terminal !== undefined && LOCATION_OR_COMMAND_FIELD_TERMINALS[terminal] === true;
}

function sanitizeJson(value: unknown, ancestors: Set<object> = new Set()): SanitizedJson {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		if (typeof value === "string" && value.trimStart().toLowerCase().startsWith("!cmd")) return { kind: "omit" };
		return { kind: "value", value };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Invalid model extension: values must be JSON-compatible");
		return { kind: "value", value };
	}
	if (typeof value !== "object") {
		throw new TypeError("Invalid model extension: values must be JSON-compatible");
	}
	if (ancestors.has(value)) throw new TypeError("Invalid model extension: values must be acyclic");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Invalid model extension: values must be JSON-compatible");
			}
			const result: JsonValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Invalid model extension: values must be JSON-compatible");
				}
				const sanitized = sanitizeJson(descriptor.value, ancestors);
				if (sanitized.kind === "omit") return sanitized;
				result.push(sanitized.value);
			}
			return { kind: "value", value: result };
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Invalid model extension: values must be JSON-compatible");
		}
		const result: Record<string, JsonValue> = {};
		for (const field of Reflect.ownKeys(value)) {
			if (typeof field !== "string") {
				throw new TypeError("Invalid model extension: values must be JSON-compatible");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Invalid model extension: values must be JSON-compatible");
			}
			if (field === "__proto__" || field === "constructor" || field === "prototype") {
				throw new TypeError("Invalid model extension: field names must be safe");
			}
			if (isUnsafeField(field)) continue;
			const sanitized = sanitizeJson(descriptor.value, ancestors);
			if (sanitized.kind === "value") result[field] = sanitized.value;
		}
		return { kind: "value", value: result };
	} finally {
		ancestors.delete(value);
	}
}

function sanitizeJsonObject(value: unknown): JsonObject {
	const sanitized = sanitizeJson(value);
	if (
		sanitized.kind !== "value" ||
		typeof sanitized.value !== "object" ||
		sanitized.value === null ||
		Array.isArray(sanitized.value)
	) {
		throw new TypeError("Invalid model extensions: each namespace must be an object");
	}
	return sanitized.value as JsonObject;
}

function readExtensions(record: Record<string, unknown>): Readonly<Partial<Record<SourceNamespace, JsonObject>>> {
	if (!hasOwn(record, "extensions")) return {};
	const raw = record.extensions;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TypeError("Invalid model record: extensions must be an object");
	}
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Invalid model record: extensions must be a plain object");
	}
	const result: Partial<Record<SourceNamespace, JsonObject>> = {};
	for (const namespace of Reflect.ownKeys(raw)) {
		if (typeof namespace !== "string" || EXTENSION_NAMESPACES[namespace as SourceNamespace] !== true) {
			throw new TypeError("Invalid model record: extensions contains an unsupported namespace");
		}
		const descriptor = Object.getOwnPropertyDescriptor(raw, namespace);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			throw new TypeError("Invalid model record: extensions must be JSON-compatible");
		}
		result[namespace as SourceNamespace] = sanitizeJsonObject(descriptor.value);
	}
	return result;
}

function collectUnknownFields(record: Record<string, unknown>): JsonObject {
	const result: Record<string, JsonValue> = {};
	for (const field of Object.keys(record)) {
		if (KNOWN_FIELDS[field] === true || isUnsafeField(field)) continue;
		const sanitized = sanitizeJson(record[field]);
		if (sanitized.kind === "value") result[field] = sanitized.value;
	}
	return result;
}

function recordToModelSpecV1(value: unknown, source: SourceNamespace): ModelSpecV1 {
	const record = asRecord(value, source);
	const providerId = requiredString(record, "provider", source);
	const authRef = validateAuthRef(optionalString(record, "authRef", source), providerId);
	const supportsToolUse = optionalBoolean(record, "supportsTools", source);
	const contextLength = optionalContextLength(record, source);
	let spec = cloneModelSpecV1({
		version: 1,
		providerId,
		modelId: requiredString(record, "id", source),
		...(authRef === undefined ? {} : { authRef }),
		...(supportsToolUse === undefined ? {} : { supportsToolUse }),
		...(contextLength === undefined ? {} : { contextLength }),
	});

	const extensions = readExtensions(record);
	for (const namespace of ["prime", "omp"] as const) {
		const extension = extensions[namespace];
		if (extension !== undefined) spec = withModelSpecV1Extension(spec, namespace, extension);
	}
	const unknownFields = collectUnknownFields(record);
	const merged: Record<string, JsonValue> = { ...getModelSpecV1Extension(spec, source), ...unknownFields };
	return Object.keys(merged).length === 0 ? spec : withModelSpecV1Extension(spec, source, merged);
}

/** Converts one Prime model configuration record without resolving runtime state or credentials. */
export function primeModelRecordToModelSpecV1(value: unknown): ModelSpecV1 {
	return recordToModelSpecV1(value, "prime");
}

/** Converts one OMP model configuration record without resolving runtime state or credentials. */
export function ompModelRecordToModelSpecV1(value: unknown): ModelSpecV1 {
	return recordToModelSpecV1(value, "omp");
}

function modelSpecV1ToRecord(specValue: unknown): PrimeModelConfigRecord | OmpRunnableModelConfigRecord {
	const spec = cloneModelSpecV1(specValue);
	validateAuthRef(spec.authRef, spec.providerId);
	return {
		provider: spec.providerId,
		id: spec.modelId,
		...(spec.authRef === undefined ? {} : { authRef: spec.authRef }),
		...(spec.supportsToolUse === undefined ? {} : { supportsTools: spec.supportsToolUse }),
		...(spec.contextLength === undefined ? {} : { contextWindow: spec.contextLength }),
		...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
	};
}

/** Projects a validated spec to a Prime model record and does not add inferred model metadata. */
export function modelSpecV1ToPrimeModelRecord(spec: unknown): PrimeModelConfigRecord {
	return modelSpecV1ToRecord(spec);
}

/** Projects a validated spec to an OMP runnable record and leaves model and auth resolution to the runtime. */
export function modelSpecV1ToOmpModelRecord(spec: unknown): OmpRunnableModelConfigRecord {
	return modelSpecV1ToRecord(spec);
}
