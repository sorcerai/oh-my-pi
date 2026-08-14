import { describe, expect, it } from "bun:test";
import {
	cloneModelSpecV1,
	getModelSpecV1Extension,
	isModelSpecV1SecretBearingKey,
	type JsonObject,
	ModelSpecV1ValidationError,
	validateModelSpecV1,
	withModelSpecV1Extension,
} from "@oh-my-pi/pi-catalog";

describe("ModelSpecV1", () => {
	it("validates and clones a sparse spec without adding optional fields", () => {
		const input = {
			version: 1,
			providerId: "example-provider",
			modelId: "example-model",
		} as const;

		const spec = validateModelSpecV1(input);
		const cloned = cloneModelSpecV1(spec);

		expect(spec).toBe(input);
		expect(Object.hasOwn(cloned, "authRef")).toBe(false);
		expect(Object.hasOwn(cloned, "supportsToolUse")).toBe(false);
		expect(Object.hasOwn(cloned, "contextLength")).toBe(false);
		expect(Object.hasOwn(cloned, "extensions")).toBe(false);
	});

	it("preserves explicit false, null, and namespaced JSON extensions when cloning", () => {
		const input = {
			version: 1,
			providerId: "example-provider",
			modelId: "example-model",
			authRef: "provider:example-provider",
			supportsToolUse: false,
			contextLength: null,
			extensions: {
				prime: {
					enabled: true,
					limits: [1, null, { mode: "strict" }],
				},
				omp: { label: "local" },
			},
		} as const;

		const cloned = cloneModelSpecV1(input);

		expect(cloned).toEqual(input);
		expect(cloned).not.toBe(input);
		expect(cloned.supportsToolUse).toBe(false);
		expect(cloned.contextLength).toBeNull();
		expect(cloned.extensions?.prime).not.toBe(input.extensions.prime);
		expect(cloned.extensions?.omp).not.toBe(input.extensions.omp);
	});

	it("adds, reads, and removes one extension namespace without changing the source", () => {
		const source = validateModelSpecV1({
			version: 1,
			providerId: "example-provider",
			modelId: "example-model",
		});
		const prime = { custom: { nested: [true, 7] } } as const;

		const withPrime = withModelSpecV1Extension(source, "prime", prime);
		const withBoth = withModelSpecV1Extension(withPrime, "omp", { channel: "stable" });
		const withoutPrime = withModelSpecV1Extension(withBoth, "prime", undefined);
		const withoutExtensions = withModelSpecV1Extension(withoutPrime, "omp", undefined);

		expect(getModelSpecV1Extension(source, "prime")).toBeUndefined();
		expect(getModelSpecV1Extension(withPrime, "prime")).toEqual(prime);
		expect(getModelSpecV1Extension(withBoth, "omp")).toEqual({ channel: "stable" });
		expect(getModelSpecV1Extension(withoutPrime, "prime")).toBeUndefined();
		expect(Object.hasOwn(withoutExtensions, "extensions")).toBe(false);
		expect(Object.hasOwn(source, "extensions")).toBe(false);
	});

	it.each([
		undefined,
		null,
		{},
		{ version: 2, providerId: "example-provider", modelId: "example-model" },
		{ version: "1", providerId: "example-provider", modelId: "example-model" },
		{ version: 1, providerId: "", modelId: "example-model" },
		{ version: 1, providerId: "example-provider", modelId: "" },
		{ version: 1, providerId: " ", modelId: "example-model" },
		{ version: 1, providerId: "example-provider", modelId: "\t" },
		{ version: 1, providerId: 7, modelId: "example-model" },
		{ version: 1, providerId: "example-provider", modelId: null },
		{ version: 1, providerId: "example-provider", modelId: "example-model", authRef: null },
		{ version: 1, providerId: "example-provider", modelId: "example-model", supportsToolUse: undefined },
		{ version: 1, providerId: "example-provider", modelId: "example-model", contextLength: undefined },
		{ version: 1, providerId: "example-provider", modelId: "example-model", extensions: undefined },
		{ version: 1, providerId: "example-provider", modelId: "example-model", extensions: { prime: undefined } },
		{ version: 1, providerId: "example-provider", modelId: "example-model", extensions: { other: {} } },
		{ version: 1, providerId: "example-provider", modelId: "example-model", unexpected: true },
	])("rejects an invalid envelope: %p", value => {
		expect(() => validateModelSpecV1(value)).toThrow(ModelSpecV1ValidationError);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid contextLength %p", contextLength => {
		expect(() =>
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				contextLength,
			}),
		).toThrow(ModelSpecV1ValidationError);
	});

	it.each([1, 128_000, null])("accepts contextLength %p", contextLength => {
		expect(
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				contextLength,
			}).contextLength,
		).toBe(contextLength);
	});

	it.each([
		{ invalid: undefined },
		{ invalid: Number.NaN },
		{ invalid: Number.NEGATIVE_INFINITY },
		{ invalid: 1n },
		{ invalid: Symbol("invalid") },
		{ invalid: () => true },
		{ invalid: new Date(0) },
		{ invalid: [undefined, "value"] },
	])("rejects non-JSON extension values", extension => {
		expect(() =>
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				extensions: { prime: extension },
			}),
		).toThrow(ModelSpecV1ValidationError);
	});

	it("rejects cyclic extension values", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(() =>
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				extensions: { prime: cyclic },
			}),
		).toThrow(ModelSpecV1ValidationError);
	});

	it.each(["__proto__", "prototype", "constructor"])("rejects prototype key %s at any depth", key => {
		const extension = { safe: { [key]: null } };

		expect(() =>
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				extensions: { prime: extension },
			}),
		).toThrow(ModelSpecV1ValidationError);
	});

	it("rejects objects with a non-JSON prototype", () => {
		const extension = { safe: { value: true } };
		Object.setPrototypeOf(extension.safe, { inherited: true });

		expect(() =>
			validateModelSpecV1({
				version: 1,
				providerId: "example-provider",
				modelId: "example-model",
				extensions: { prime: extension },
			}),
		).toThrow(ModelSpecV1ValidationError);
	});

	it.each(["apiKey", "access_token", "clientSecret", "password", "authorization"])(
		"rejects secret-bearing extension key %s at any depth",
		key => {
			const extension = { safe: [{ [key]: null }] };

			expect(() =>
				validateModelSpecV1({
					version: 1,
					providerId: "example-provider",
					modelId: "example-model",
					extensions: { omp: extension },
				}),
			).toThrow(ModelSpecV1ValidationError);
		},
	);

	it.each(["sessionCookie", "cookieValue", "Set-Cookie", "set_cookie_value"])(
		"rejects compound cookie extension key %s without echoing its value",
		key => {
			const secretValue = `secret-for-${key}`;
			let thrown: unknown;
			try {
				validateModelSpecV1({
					version: 1,
					providerId: "example-provider",
					modelId: "example-model",
					extensions: { prime: { safe: { [key]: secretValue } } },
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(ModelSpecV1ValidationError);
			expect(String(thrown)).not.toContain(secretValue);
		},
	);
	it("rejects apiKeyValue at extension roots and nested objects without echoing its value", () => {
		const secretValue = "api-key-value-that-must-not-leak";
		for (const extension of [{ apiKeyValue: secretValue }, { safe: { apiKeyValue: secretValue } }]) {
			let thrown: unknown;
			try {
				validateModelSpecV1({
					version: 1,
					providerId: "example-provider",
					modelId: "example-model",
					extensions: { prime: extension },
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(ModelSpecV1ValidationError);
			expect(String(thrown)).not.toContain(secretValue);
		}
	});

	it("classifies credential-bearing field names without dropping benign metadata", () => {
		const secretBearing = [
			"bearer",
			"jwt",
			"pat",
			"signature",
			"sessionId",
			"clientSecret",
			"privateKeyPem",
			"xApiKey",
			"accessKeyId",
			"secretAccessKey",
			"keyMaterial",
			"pem",
			"certificate",
			"privateCert",
			"serviceAccountJson",
			"openaiKey",
			"key",
			"sshKey",
			"envKey",
			"secrets",
		];
		const benign = ["fileFormat", "pathStyle", "commandTimeout", "displayName", "releaseDate", "tokenizerName"];

		expect(secretBearing.filter(field => !isModelSpecV1SecretBearingKey(field))).toEqual([]);
		expect(benign.filter(isModelSpecV1SecretBearingKey)).toEqual([]);
	});

	it("applies the same extension validation through the namespace helper", () => {
		const source = validateModelSpecV1({
			version: 1,
			providerId: "example-provider",
			modelId: "example-model",
		});
		const unsafe = { nested: { refreshToken: null } } as unknown as JsonObject;

		expect(() => withModelSpecV1Extension(source, "prime", unsafe)).toThrow(ModelSpecV1ValidationError);
	});
});
