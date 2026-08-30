import { describe, expect, it } from "bun:test";
import {
	modelSpecV1ToOmpModelRecord,
	modelSpecV1ToPrimeModelRecord,
	ompModelRecordToModelSpecV1,
	primeModelRecordToModelSpecV1,
} from "../src/config/model-spec-v1";
import { getModelsConfigSchema } from "../src/config/models-config-schema-bundle";

const excludedMarker = "excluded-sensitive-value";

describe("ModelSpecV1 model record conversions", () => {
	it("preserves identity, explicit values, and both extension namespaces through a Prime round trip", () => {
		const primeSpec = primeModelRecordToModelSpecV1({
			provider: "prime-provider",
			id: "prime-model",
			authRef: "provider:prime-provider",
			supportsTools: false,
			contextWindow: 65_536,
			primeOption: { enabled: true, labels: ["one", null] },
			extensions: {
				omp: { carriedOmpOption: "preserved" },
			},
		});

		expect(primeSpec).toEqual({
			version: 1,
			providerId: "prime-provider",
			modelId: "prime-model",
			authRef: "provider:prime-provider",
			supportsToolUse: false,
			contextLength: 65_536,
			extensions: {
				prime: { primeOption: { enabled: true, labels: ["one", null] } },
				omp: { carriedOmpOption: "preserved" },
			},
		});

		const ompRecord = modelSpecV1ToOmpModelRecord(primeSpec);
		const combinedSpec = ompModelRecordToModelSpecV1({
			...ompRecord,
			ompOption: { mode: "native", retries: 0 },
		});
		const primeRecord = modelSpecV1ToPrimeModelRecord(combinedSpec);

		expect(primeModelRecordToModelSpecV1(primeRecord)).toEqual({
			...primeSpec,
			extensions: {
				prime: { primeOption: { enabled: true, labels: ["one", null] } },
				omp: {
					carriedOmpOption: "preserved",
					ompOption: { mode: "native", retries: 0 },
				},
			},
		});
	});

	it("preserves an OMP record through Prime without inferring runtime metadata", () => {
		const ompSpec = ompModelRecordToModelSpecV1({
			provider: "omp-provider",
			id: "omp-model",
			authRef: "oauth-credential:omp-provider:7",
			supportsTools: true,
			contextWindow: null,
			ompOption: ["stable", 2],
			extensions: {
				prime: { carriedPrimeOption: false },
			},
		});

		const primeRecord = modelSpecV1ToPrimeModelRecord(ompSpec);
		const roundTripped = ompModelRecordToModelSpecV1(
			modelSpecV1ToOmpModelRecord(primeModelRecordToModelSpecV1(primeRecord)),
		);

		expect(roundTripped).toEqual(ompSpec);
		expect(modelSpecV1ToOmpModelRecord(roundTripped)).toEqual({
			provider: "omp-provider",
			id: "omp-model",
			authRef: "oauth-credential:omp-provider:7",
			supportsTools: true,
			contextWindow: null,
			extensions: {
				prime: { carriedPrimeOption: false },
				omp: { ompOption: ["stable", 2] },
			},
		});
	});

	it("omits secret-bearing and location or command-bearing data at every depth", () => {
		const commandMarker = ["!", "cmd", " excluded-command-marker"].join("");
		for (const [namespace, convert] of [
			["prime", primeModelRecordToModelSpecV1],
			["omp", ompModelRecordToModelSpecV1],
		] as const) {
			const spec = convert({
				provider: "safe-provider",
				id: "safe-model",
				apiKey: excludedMarker,
				apiKeyValue: excludedMarker,
				headers: excludedMarker,
				accessToken: excludedMarker,
				credentialPath: excludedMarker,
				credentialCommand: commandMarker,
				dynamicOption: commandMarker,
				sourceOption: {
					enabled: true,
					clientSecret: excludedMarker,
					apiKeyValue: excludedMarker,
					cachePath: excludedMarker,
					nested: { label: "safe", refreshToken: excludedMarker },
				},
			});

			expect(spec.extensions).toEqual({
				[namespace]: {
					sourceOption: {
						enabled: true,
						nested: { label: "safe" },
					},
				},
			});
			const serialized = JSON.stringify(spec);
			expect(serialized).not.toContain(excludedMarker);
			expect(serialized).not.toContain("excluded-command-marker");
		}
	});
	it("preserves metadata-shaped field names while omitting actual locations and commands", () => {
		const commandReference = ["!", "cmd", " excluded-command-marker"].join("");
		for (const [namespace, convert] of [
			["prime", primeModelRecordToModelSpecV1],
			["omp", ompModelRecordToModelSpecV1],
		] as const) {
			const spec = convert({
				provider: "safe-provider",
				id: "safe-model",
				fileFormat: "jsonl",
				pathStyle: "posix",
				commandTimeout: 30_000,
				cachePath: excludedMarker,
				sourceLocation: excludedMarker,
				launchCommand: excludedMarker,
				dynamicOption: commandReference,
				sourceOption: {
					fileFormat: "binary",
					pathStyle: "relative",
					commandTimeout: 5_000,
					outputFile: excludedMarker,
					workingDirectory: excludedMarker,
					launchCommand: excludedMarker,
					dynamicOption: commandReference,
				},
			});

			expect(spec.extensions).toEqual({
				[namespace]: {
					fileFormat: "jsonl",
					pathStyle: "posix",
					commandTimeout: 30_000,
					sourceOption: {
						fileFormat: "binary",
						pathStyle: "relative",
						commandTimeout: 5_000,
					},
				},
			});
			const serialized = JSON.stringify(spec);
			expect(serialized).not.toContain(excludedMarker);
			expect(serialized).not.toContain("excluded-command-marker");
			for (const project of [modelSpecV1ToPrimeModelRecord, modelSpecV1ToOmpModelRecord]) {
				expect(convert(project(spec))).toEqual(spec);
			}
		}
	});

	it("omits compound cookie fields from specs and persisted projections while benign fields round-trip", () => {
		for (const [namespace, convert] of [
			["prime", primeModelRecordToModelSpecV1],
			["omp", ompModelRecordToModelSpecV1],
		] as const) {
			const spec = convert({
				provider: "safe-provider",
				id: "safe-model",
				sessionCookie: excludedMarker,
				cookieValue: excludedMarker,
				"Set-Cookie": excludedMarker,
				sourceOption: {
					label: "preserved",
					set_cookie_value: excludedMarker,
				},
			});

			expect(spec.extensions).toEqual({
				[namespace]: {
					sourceOption: { label: "preserved" },
				},
			});
			for (const project of [modelSpecV1ToPrimeModelRecord, modelSpecV1ToOmpModelRecord]) {
				const persisted = project(spec);
				expect(JSON.stringify(persisted)).not.toContain(excludedMarker);
				expect(convert(persisted)).toEqual(spec);
			}
		}
	});

	it("rejects compound cookie fields from persisted projections without echoing values", () => {
		for (const project of [modelSpecV1ToPrimeModelRecord, modelSpecV1ToOmpModelRecord]) {
			const secretValue = `cookie-${excludedMarker}`;
			let thrown: unknown;
			try {
				project({
					version: 1,
					providerId: "safe-provider",
					modelId: "safe-model",
					extensions: { prime: { sessionCookie: secretValue } },
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);
			expect(String(thrown)).not.toContain(secretValue);
		}
	});

	it("rejects malformed or provider-mismatched authRef values without echoing them", () => {
		const unsafeRefs = ["not-a-local-reference", "provider:different-provider"];
		for (const authRef of unsafeRefs) {
			for (const convert of [primeModelRecordToModelSpecV1, ompModelRecordToModelSpecV1]) {
				let thrown: unknown;
				try {
					convert({ provider: "provider", id: "model", authRef });
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(Error);
				expect(String(thrown)).not.toContain(excludedMarker);
				expect(String(thrown)).not.toContain(authRef);
			}
			for (const convert of [modelSpecV1ToPrimeModelRecord, modelSpecV1ToOmpModelRecord]) {
				let thrown: unknown;
				try {
					convert({ version: 1, providerId: "provider", modelId: "model", authRef });
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(Error);
				expect(String(thrown)).not.toContain(excludedMarker);
				expect(String(thrown)).not.toContain(authRef);
			}
		}
	});

	it("rejects malformed records without echoing their values", () => {
		const malformedRecords: unknown[] = [
			null,
			[],
			{},
			{ provider: "", id: "model" },
			{ provider: "provider", id: "" },
			{ provider: "provider", id: "model", authRef: 1 },
			{ provider: "provider", id: "model", supportsTools: "false" },
			{ provider: "provider", id: "model", contextWindow: 0 },
			{ provider: "provider", id: "model", contextWindow: 1.5 },
			{ provider: "provider", id: "model", unknownValue: undefined },
		];

		for (const record of malformedRecords) {
			expect(() => primeModelRecordToModelSpecV1(record)).toThrow();
			expect(() => ompModelRecordToModelSpecV1(record)).toThrow();
		}
		for (const convert of [modelSpecV1ToPrimeModelRecord, modelSpecV1ToOmpModelRecord]) {
			expect(() => convert({ version: 2, providerId: "provider", modelId: "model" })).toThrow();
			expect(() => convert({ version: 1, providerId: "provider", modelId: "model", contextLength: 0 })).toThrow();
		}

		let thrown: unknown;
		try {
			primeModelRecordToModelSpecV1({
				provider: "provider",
				id: "model",
				supportsTools: excludedMarker,
				apiKey: excludedMarker,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(String(thrown)).not.toContain(excludedMarker);
	});

	it("preserves absent, false, and null as different states", () => {
		const absent = primeModelRecordToModelSpecV1({ provider: "provider", id: "absent" });
		const explicit = primeModelRecordToModelSpecV1({
			provider: "provider",
			id: "explicit",
			supportsTools: false,
			contextWindow: null,
		});

		expect(absent).not.toHaveProperty("supportsToolUse");
		expect(absent).not.toHaveProperty("contextLength");
		expect(modelSpecV1ToOmpModelRecord(absent)).not.toHaveProperty("supportsTools");
		expect(modelSpecV1ToOmpModelRecord(absent)).not.toHaveProperty("contextWindow");
		expect(explicit).toMatchObject({ supportsToolUse: false, contextLength: null });
		expect(modelSpecV1ToPrimeModelRecord(explicit)).toMatchObject({ supportsTools: false, contextWindow: null });
	});
});

describe("models config extension namespaces", () => {
	const validate = (extensions: unknown): unknown =>
		getModelsConfigSchema()({
			providers: {
				"example-provider": { apiKey: "k", baseUrl: "https://example.invalid", models: [{ id: "m", extensions }] },
			},
		});
	const rejected = (result: unknown): boolean => result?.constructor?.name?.endsWith("Errors") === true;

	it("accepts the interchange namespaces and rejects any other namespace", () => {
		expect(rejected(validate({ prime: { a: 1 } }))).toBe(false);
		expect(rejected(validate({ omp: { a: 1 } }))).toBe(false);
		expect(rejected(validate({ prime: { a: 1 }, omp: { b: 2 } }))).toBe(false);
		// Undeclared namespaces must fail as config shape, not as a converter TypeError at load.
		expect(rejected(validate({ Prime: { a: 1 } }))).toBe(true);
		expect(rejected(validate({ vendor: { a: 1 } }))).toBe(true);
	});
});
