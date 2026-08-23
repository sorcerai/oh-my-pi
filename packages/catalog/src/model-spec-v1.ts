/** A JSON scalar accepted by model interchange extensions. */
export type JsonPrimitive = null | boolean | number | string;
/** A readonly JSON array accepted by model interchange extensions. */
export type JsonArray = readonly JsonValue[];
/** A readonly JSON object accepted by model interchange extensions. */
export type JsonObject = { readonly [key: string]: JsonValue };
/** A finite, acyclic JSON value accepted by model interchange extensions. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** The source harness namespaces supported by {@link ModelSpecV1}. */
export type ModelSpecV1ExtensionNamespace = "prime" | "omp";

/** Harness-specific, non-secret model fields that survive conversion. */
export interface ModelSpecV1Extensions {
	readonly prime?: JsonObject;
	readonly omp?: JsonObject;
}

/**
 * Versioned, runtime-independent model identity and explicit source capabilities.
 *
 * Credential material is never part of this contract. `authRef` is an opaque
 * reference that a local runtime can resolve without exposing its value.
 */
export interface ModelSpecV1 {
	readonly version: 1;
	readonly providerId: string;
	readonly modelId: string;
	readonly authRef?: string;
	readonly supportsToolUse?: boolean;
	readonly contextLength?: number | null;
	readonly extensions?: Readonly<ModelSpecV1Extensions>;
}

/** A structural or security validation failure for {@link ModelSpecV1}. */
export class ModelSpecV1ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelSpecV1ValidationError";
	}
}

const MODEL_SPEC_FIELDS: Record<string, true> = {
	version: true,
	providerId: true,
	modelId: true,
	authRef: true,
	supportsToolUse: true,
	contextLength: true,
	extensions: true,
};
const EXTENSION_NAMESPACES: Record<ModelSpecV1ExtensionNamespace, true> = { prime: true, omp: true };
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function fail(message: string): never {
	throw new ModelSpecV1ValidationError(message);
}

function assertOwnEnumerableDataProperties(value: object, message: string): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") fail(message);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(message);
	}
}

function expectPlainObject(value: unknown, message: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(message);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(message);
	assertOwnEnumerableDataProperties(value, message);
	return value as Record<string, unknown>;
}

/**
 * Word-level bans. Classification is deliberately over-broad: dropping a benign
 * metadata field costs a lost round-trip value, while admitting one credential
 * field persists it into a second on-disk config.
 */
const SECRET_BEARING_FIELD_WORDS: Readonly<Record<string, true>> = {
	auth: true,
	authentication: true,
	authorization: true,
	bearer: true,
	cert: true,
	certificate: true,
	cookie: true,
	credential: true,
	credentials: true,
	header: true,
	headers: true,
	jwt: true,
	key: true,
	oauth: true,
	passphrase: true,
	passwd: true,
	password: true,
	pat: true,
	pem: true,
	secret: true,
	secrets: true,
	signature: true,
	token: true,
};

/** Returns whether a field name can contain credential or request-secret material. */
export function isModelSpecV1SecretBearingKey(key: string): boolean {
	const words = key
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (words.some(word => SECRET_BEARING_FIELD_WORDS[word] === true)) return true;

	const normalized = words.join("");
	if (normalized.includes("apikey") || normalized.includes("cookie") || /headers?$/.test(normalized)) return true;
	if (normalized.includes("serviceaccount") || normalized.endsWith("sessionid")) return true;
	if (
		normalized.endsWith("accesstoken") ||
		normalized.endsWith("refreshtoken") ||
		normalized.endsWith("idtoken") ||
		normalized.endsWith("authtoken") ||
		normalized.endsWith("bearertoken") ||
		normalized.endsWith("sessiontoken") ||
		normalized.endsWith("privatekey") ||
		normalized.endsWith("secretkey") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("password") ||
		normalized.endsWith("passwd") ||
		normalized.endsWith("passphrase")
	)
		return true;
	return (
		/^(?:api)?key(?:path|file|command)$/.test(normalized) ||
		/^(?:credentials?|token)(?:path|file|command)$/.test(normalized)
	);
}

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("ModelSpecV1 extension must contain JSON values only");
		return;
	}
	if (typeof value !== "object") fail("ModelSpecV1 extension must contain JSON values only");
	if (ancestors.has(value)) fail("ModelSpecV1 extension must not contain cycles");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
				fail("ModelSpecV1 extension must contain JSON values only");
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
					fail("ModelSpecV1 extension must contain JSON values only");
				assertJsonValue(descriptor.value, ancestors);
			}
			return;
		}

		const object = expectPlainObject(value, "ModelSpecV1 extension must contain JSON values only");
		for (const key of Object.keys(object)) {
			if (DANGEROUS_KEYS.has(key)) fail("ModelSpecV1 extension contains a forbidden key");
			if (isModelSpecV1SecretBearingKey(key)) fail("ModelSpecV1 extension contains a forbidden key");
			assertJsonValue(object[key], ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function assertExtensionObject(value: unknown): asserts value is JsonObject {
	const object = expectPlainObject(value, "ModelSpecV1 extension must be a plain object");
	assertJsonValue(object, new Set());
}

function assertModelSpecV1(value: unknown): asserts value is ModelSpecV1 {
	const spec = expectPlainObject(value, "ModelSpecV1 must be a plain object");
	for (const key of Object.keys(spec)) {
		if (DANGEROUS_KEYS.has(key)) fail("ModelSpecV1 contains a forbidden field");
		if (MODEL_SPEC_FIELDS[key] !== true) fail("ModelSpecV1 contains an unsupported field");
	}
	if (spec.version !== 1) fail("ModelSpecV1 version must be 1");
	if (typeof spec.providerId !== "string" || spec.providerId.trim().length === 0)
		fail("ModelSpecV1 providerId must be a non-empty string");
	if (typeof spec.modelId !== "string" || spec.modelId.trim().length === 0)
		fail("ModelSpecV1 modelId must be a non-empty string");
	if (Object.hasOwn(spec, "authRef") && typeof spec.authRef !== "string") fail("ModelSpecV1 authRef must be a string");
	if (Object.hasOwn(spec, "supportsToolUse") && typeof spec.supportsToolUse !== "boolean")
		fail("ModelSpecV1 supportsToolUse must be a boolean");
	if (
		Object.hasOwn(spec, "contextLength") &&
		spec.contextLength !== null &&
		(typeof spec.contextLength !== "number" || !Number.isInteger(spec.contextLength) || spec.contextLength <= 0)
	)
		fail("ModelSpecV1 contextLength must be a positive integer or null");
	if (!Object.hasOwn(spec, "extensions")) return;

	const extensions = expectPlainObject(spec.extensions, "ModelSpecV1 extensions must be a plain object");
	for (const namespace of Object.keys(extensions)) {
		if (DANGEROUS_KEYS.has(namespace)) fail("ModelSpecV1 extensions contain a forbidden namespace");
		if (EXTENSION_NAMESPACES[namespace as ModelSpecV1ExtensionNamespace] !== true)
			fail("ModelSpecV1 extensions contain an unsupported namespace");
		assertExtensionObject(extensions[namespace]);
	}
}

/**
 * Validates an untrusted value and returns it unchanged with a narrowed type.
 *
 * Errors describe only the violated contract and never include input values or
 * untrusted extension keys.
 */
export function validateModelSpecV1(value: unknown): ModelSpecV1 {
	assertModelSpecV1(value);
	return value;
}

/** Validates and deep-clones a model spec while preserving optional-field absence. */
export function cloneModelSpecV1(value: unknown): ModelSpecV1 {
	const spec = validateModelSpecV1(value);
	return validateModelSpecV1(structuredClone(spec));
}

/** Reads one harness namespace without merging it with another namespace. */
export function getModelSpecV1Extension(
	spec: ModelSpecV1,
	namespace: ModelSpecV1ExtensionNamespace,
): JsonObject | undefined {
	return spec.extensions?.[namespace];
}

/**
 * Returns a cloned spec with one validated namespace added, replaced, or removed.
 *
 * Removing the last namespace also removes the empty `extensions` envelope.
 */
export function withModelSpecV1Extension(
	specInput: ModelSpecV1,
	namespace: ModelSpecV1ExtensionNamespace,
	extension: JsonObject | undefined,
): ModelSpecV1 {
	const spec = cloneModelSpecV1(specInput);
	if (extension !== undefined) assertExtensionObject(extension);

	const extensions: { prime?: JsonObject; omp?: JsonObject } = { ...spec.extensions };
	if (extension === undefined) delete extensions[namespace];
	else extensions[namespace] = structuredClone(extension);

	if (extensions.prime !== undefined || extensions.omp !== undefined)
		return validateModelSpecV1({ ...spec, extensions });

	const result: { -readonly [Key in keyof ModelSpecV1]: ModelSpecV1[Key] } = { ...spec };
	delete result.extensions;
	return validateModelSpecV1(result);
}
