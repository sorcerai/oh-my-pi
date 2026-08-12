import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import type { CanonicalToolPair, JsonValue } from "../src/session/spec";
import { mapOmpToolPair, mapPrimeToolPair } from "../src/session/tool-map";
import type { SynthesizedToolCall, SynthesizedToolResult } from "../src/session/tool-synthesis";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ompTools = [
	"read",
	"grep",
	"glob",
	"web_search",
	"write",
	"edit",
	"bash",
	"lsp",
	"hub",
	"task",
	"todo",
	"mystery_tool",
] as const;

type ToolBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "mime"; readonly data: string; readonly mimeType: string }
	| { readonly type: "audio"; readonly data: string; readonly mimeType: string }
	| { readonly type: string; readonly data?: string; readonly mimeType?: string };

type HistoricalToolResult = {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly ToolBlock[];
	readonly isError: boolean;
};

type MappingInput = {
	readonly pair: CanonicalToolPair;
	readonly result: HistoricalToolResult;
	readonly cas: FileCas;
};

async function makeCas(): Promise<FileCas> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-tool-map-"));
	temporaryDirectories.push(root);
	return new FileCas(root);
}

async function makeSource(
	cas: FileCas,
	toolName: string,
	callId: string,
	argsSnapshot: JsonValue,
	content: readonly ToolBlock[] = [{ type: "text", text: "historical output" }],
	isError = false,
	options: { readonly includeOriginalCallRef?: boolean; readonly includeResultRef?: boolean } = {},
): Promise<MappingInput & { callBytes: Uint8Array; resultBytes: Uint8Array }> {
	const callBytes = encoder.encode(
		JSON.stringify({ type: "toolCall", id: callId, name: toolName, arguments: argsSnapshot }),
	);
	const resultBytes = encoder.encode(
		JSON.stringify({ role: "toolResult", toolCallId: callId, toolName, content, isError }),
	);
	const pair: CanonicalToolPair = {
		toolName,
		callId,
		argsSnapshot,
		...(options.includeOriginalCallRef === false ? {} : { originalCallRef: await cas.put(callBytes) }),
		...(options.includeResultRef === false ? {} : { resultRef: await cas.put(resultBytes) }),
	};
	return {
		pair,
		result: { role: "toolResult", toolCallId: callId, toolName, content, isError },
		cas,
		callBytes,
		resultBytes,
	};
}

function callArguments(call: SynthesizedToolCall): Record<string, JsonValue> {
	return call.arguments as Record<string, JsonValue>;
}

function resultContent(result: SynthesizedToolResult): readonly ToolBlock[] {
	return result.content as readonly ToolBlock[];
}

function expectedOmpCode(toolName: string, originalRef: string): string {
	return `# bridged:omp/${toolName} ${originalRef}`;
}
function expectedPrimeShellCommand(originalRef: string, _command: string): string {
	return `# bridged:prime/ipython ${originalRef}`;
}
function expectedPrimeSource(originalRef: string, _code: string): string {
	return `# bridged:prime/ipython ${originalRef}`;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session tool-continuity map", () => {
	describe("OMP historical tools to inert Prime ipython", () => {
		for (const toolName of ompTools) {
			it(`maps ${toolName} with stable inert code and paired IDs`, async () => {
				const cas = await makeCas();
				const source = await makeSource(cas, toolName, `omp-call-${toolName}`, { path: "README.md" });
				const mapped = await mapOmpToolPair(source);
				const call = mapped.call as SynthesizedToolCall;
				const result = mapped.result as SynthesizedToolResult;
				const originalRef = source.pair.originalCallRef?.hash;
				if (!originalRef) throw new Error("missing original call CAS ref");
				const code = callArguments(call).code;
				if (typeof code !== "string") throw new Error("mapped ipython call has no code");

				expect(call).toMatchObject({
					type: "toolCall",
					id: source.pair.callId,
					name: "ipython",
					arguments: { code: expectedOmpCode(toolName, originalRef) },
				});
				expect(code).toStartWith(`# bridged:omp/${toolName} ${originalRef}`);
				expect(code).not.toMatch(/omp_tools|fetch\s*\(|Bun\.|open\s*\(|subprocess|os\.system/);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: source.pair.callId,
					toolName: "ipython",
					isError: false,
				});
				expect(mapped.pair).toMatchObject({
					toolName,
					callId: source.pair.callId,
					originalCallRef: source.pair.originalCallRef,
					resultRef: source.pair.resultRef,
				});
				expect(mapped.pair.synthesizedCallRef).toBeDefined();
				expect(mapped.losses).toEqual([]);
			});
		}

		it("does not leak credentials into synthesized historical code", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "web_search", "omp-credential-call", {
				query: "private status",
				auth: { cookie: "cookie-secret", credential: "credential-secret", session: "session-secret" },
				arbitrary: "arbitrary-payload-secret",
				apiKey: "super-secret-api-key",
				token: "bearer-secret-token",
			});
			const mapped = await mapOmpToolPair(source);
			const call = mapped.call as SynthesizedToolCall;
			const result = mapped.result as SynthesizedToolResult;
			const serialized = JSON.stringify({ call, result });

			expect(serialized).not.toContain("cookie-secret");
			expect(serialized).not.toContain("credential-secret");
			expect(serialized).not.toContain("session-secret");
			expect(serialized).not.toContain("arbitrary-payload-secret");
			expect(serialized).not.toContain("super-secret-api-key");
			expect(serialized).not.toContain("bearer-secret-token");
			expect(callArguments(call).code).toStartWith(`# bridged:omp/web_search ${source.pair.originalCallRef?.hash}`);
		});

		it("preserves images, errors, and unsupported MIME content without changing pairing", async () => {
			const cas = await makeCas();
			const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
			const source = await makeSource(cas, "read", "omp-result-call", { path: "diagram.png" }, [image], true);
			const mapped = await mapOmpToolPair(source);
			const result = mapped.result as SynthesizedToolResult;

			expect(result).toMatchObject({ toolCallId: "omp-result-call", toolName: "ipython", isError: true });
			expect(resultContent(result)).toEqual([image]);

			const unsupported = await makeSource(cas, "read", "omp-mime-call", { path: "report.wav" }, [
				{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
			]);
			const mappedUnsupported = await mapOmpToolPair(unsupported);
			const unsupportedResult = mappedUnsupported.result as SynthesizedToolResult;
			const unsupportedSerialized = JSON.stringify(unsupportedResult);

			expect(unsupportedSerialized).toContain(unsupported.pair.resultRef!.hash);
			expect(mappedUnsupported.losses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "entry_metadata_unrepresentable",
						detail: expect.stringContaining("audio/wav"),
					}),
				]),
			);
			expect(unsupportedResult.toolName).toBe("ipython");
			expect(unsupportedResult.toolCallId).toBe(unsupported.pair.callId);
			const missingResultRef = await makeSource(
				cas,
				"read",
				"omp-missing-mime",
				{ path: "report.pdf" },
				[{ type: "mime", data: "JVBERi0xLjQ=", mimeType: "application/pdf" }],
				false,
				{ includeResultRef: false },
			);
			const mappedMissingResultRef = await mapOmpToolPair(missingResultRef);
			expect(missingResultRef.pair.resultRef).toBeUndefined();
			expect(mappedMissingResultRef.losses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "missing_source_bytes" }),
					expect.objectContaining({ code: "entry_metadata_unrepresentable" }),
				]),
			);

			const unknownBlock = await makeSource(cas, "read", "omp-unknown-block", { path: "record.bin" }, [
				{ type: "binary", data: "AAE=", mimeType: undefined },
			]);
			const mappedUnknownBlock = await mapOmpToolPair(unknownBlock);
			expect(mappedUnknownBlock.losses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "entry_metadata_unrepresentable",
						detail: expect.stringContaining("binary"),
					}),
				]),
			);
		});
		it("records missing source bytes without an unsupported-content loss for text results", async () => {
			const cas = await makeCas();
			const ompSource = await makeSource(
				cas,
				"read",
				"omp-text-missing-result",
				{ path: "README.md" },
				[{ type: "text", text: "historical text" }],
				false,
				{ includeResultRef: false },
			);
			const primeSource = await makeSource(
				cas,
				"ipython",
				"prime-text-missing-result",
				{ code: "print('text')" },
				[{ type: "text", text: "historical text" }],
				false,
				{ includeResultRef: false },
			);

			const ompMapped = await mapOmpToolPair(ompSource);
			const primeMapped = await mapPrimeToolPair(primeSource);
			for (const losses of [ompMapped.losses, primeMapped.losses]) {
				expect(losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_source_bytes" })]));
				expect(losses).not.toEqual(
					expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
				);
			}
		});

		it("records missing source bytes without an unsupported-content loss for image results", async () => {
			const cas = await makeCas();
			const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
			const ompSource = await makeSource(
				cas,
				"read",
				"omp-image-missing-result",
				{ path: "diagram.png" },
				[image],
				false,
				{
					includeResultRef: false,
				},
			);
			const primeSource = await makeSource(
				cas,
				"ipython",
				"prime-image-missing-result",
				{ code: "print('image')" },
				[image],
				false,
				{
					includeResultRef: false,
				},
			);

			const ompMapped = await mapOmpToolPair(ompSource);
			const primeMapped = await mapPrimeToolPair(primeSource);
			for (const losses of [ompMapped.losses, primeMapped.losses]) {
				expect(losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_source_bytes" })]));
				expect(losses).not.toEqual(
					expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
				);
			}
		});

		it("does not turn an unknown tool name with control characters into executable Python", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "unknown\nimport os\r\x1b", "omp-unsafe-tool", { arbitrary: "value" });
			const mapped = await mapOmpToolPair(source);
			const code = callArguments(mapped.call as SynthesizedToolCall).code;
			if (typeof code !== "string") throw new Error("mapped ipython call has no code");

			expect(code.split("\n").every(line => line.startsWith("#"))).toBe(true);
			expect(code).not.toContain("import os");
			expect(code).not.toContain("\x1b");
		});

		it("rejects a pair/result call ID or tool name mismatch", async () => {
			const cas = await makeCas();
			const ompSource = await makeSource(cas, "read", "omp-mismatch-call", { path: "README.md" });
			const primeSource = await makeSource(cas, "ipython", "prime-mismatch-call", { code: "print('x')" });

			await expect(
				mapOmpToolPair({
					...ompSource,
					result: { ...ompSource.result, toolCallId: "different-call" },
				}),
			).rejects.toThrow(/call/i);
			await expect(
				mapPrimeToolPair({
					...primeSource,
					result: { ...primeSource.result, toolName: "different-tool" },
				}),
			).rejects.toThrow(/tool/i);
			await expect(
				mapPrimeToolPair({
					...primeSource,
					result: { ...primeSource.result, toolCallId: "different-call" },
				}),
			).rejects.toThrow(/call/i);
		});

		it("records missing source bytes when the original call CAS reference is absent", async () => {
			const cas = await makeCas();
			const ompSource = await makeSource(cas, "read", "omp-missing-call", { path: "README.md" }, undefined, false, {
				includeOriginalCallRef: false,
			});
			const primeSource = await makeSource(
				cas,
				"ipython",
				"prime-missing-call",
				{ code: "print('historical')" },
				undefined,
				false,
				{
					includeOriginalCallRef: false,
				},
			);

			const ompMapped = await mapOmpToolPair(ompSource);
			const primeMapped = await mapPrimeToolPair(primeSource);
			expect(ompMapped.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "missing_source_bytes" })]),
			);
			expect(primeMapped.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "missing_source_bytes" })]),
			);
		});

		it("produces deterministic output for identical canonical input", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "edit", "omp-deterministic-call", {
				path: "src/file.ts",
				patch: "@@\n-old\n+new",
			});

			const first = await mapOmpToolPair(source);
			const second = await mapOmpToolPair(source);

			expect(second).toEqual(first);
		});

		it("restores exact original OMP call and result bytes from CAS", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "bash", "omp-cas-call", { command: "printf hello" });
			const mapped = await mapOmpToolPair(source);

			expect(await cas.read(mapped.pair.originalCallRef!)).toEqual(source.callBytes);
			expect(await cas.read(mapped.pair.resultRef!)).toEqual(source.resultBytes);
			expect(mapped.pair.synthesizedCallRef).toBeDefined();
			expect(decoder.decode(await cas.read(mapped.pair.synthesizedCallRef!))).toContain(
				`# bridged:omp/bash ${source.pair.originalCallRef?.hash}`,
			);
		});
	});

	describe("Prime ipython to OMP eval/bash", () => {
		it("maps ordinary Python to eval with deterministic source and matching result name", async () => {
			const cas = await makeCas();
			const code = "value = 2 + 2\nprint(value)";
			const source = await makeSource(cas, "ipython", "prime-python-call", { code });
			const mapped = await mapPrimeToolPair(source);
			const call = mapped.call as SynthesizedToolCall;
			const result = mapped.result as SynthesizedToolResult;
			const originalRef = source.pair.originalCallRef?.hash;
			if (!originalRef) throw new Error("missing original call CAS ref");

			expect(call).toMatchObject({
				type: "toolCall",
				id: "prime-python-call",
				name: "eval",
				arguments: { language: "py", code: expectedPrimeSource(originalRef, code) },
			});
			expect(result).toMatchObject({ role: "toolResult", toolCallId: "prime-python-call", toolName: "eval" });
			expect(mapped.losses).toEqual([]);
		});

		it("maps exactly one top-level shell line to bash", async () => {
			const cas = await makeCas();
			const code = "!printf 'historical hello'";
			const source = await makeSource(cas, "ipython", "prime-shell-call", { code });
			const mapped = await mapPrimeToolPair(source);
			const call = mapped.call as SynthesizedToolCall;
			const originalRef = source.pair.originalCallRef?.hash;
			if (!originalRef) throw new Error("missing original call CAS ref");

			expect(call).toMatchObject({
				type: "toolCall",
				id: "prime-shell-call",
				name: "bash",
				arguments: { command: expectedPrimeShellCommand(originalRef, "printf 'historical hello'") },
			});
			expect((callArguments(call).command as string).split("\n").every(line => line.startsWith("#"))).toBe(true);
			expect(mapped.result.toolName).toBe("bash");
			expect(mapped.result.toolCallId).toBe("prime-shell-call");
		});

		it.each([
			["multiple shell lines", "!echo one\n!echo two", "eval"],
			["empty bang", "!", "eval"],
			["indented bang", "  !echo indented", "eval"],
			["leading and trailing blank lines", "\n!echo surrounded\n\n", "bash"],
		])("%s has the correct shell boundary", async (_label, code, expectedName) => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", `prime-boundary-${expectedName}`, { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe(expectedName);
			if (expectedName === "bash") {
				const command = callArguments(mapped.call as SynthesizedToolCall).command;
				if (typeof command !== "string") throw new Error("mapped bash call has no command");
				expect(command.split("\n").every(line => line.startsWith("#"))).toBe(true);
			}
		});
		it.each([
			["CR surrounding blanks", "\r\n!echo cr\r\n", "bash", false],
			["CRLF surrounding blanks", "\r\n!echo crlf\r\n", "bash", false],
			["CR multiple shell lines", "!echo one\r!echo two", "eval", true],
			["CRLF multiple shell lines", "!echo one\r\n!echo two", "eval", true],
			["CR mixed Python and shell", "value = 1\r\n!echo mixed", "eval", true],
			["CRLF mixed Python and shell", "value = 1\r\n!echo mixed", "eval", true],
		])("%s has the correct line-ending boundary", async (_label, code, expectedName, demoted) => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", `prime-cr-boundary-${expectedName}`, { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe(expectedName);
			expect(mapped.losses.some(loss => loss.code === "entry_metadata_unrepresentable")).toBe(demoted);
		});

		it.each([
			["single", 'text = "unterminated\n!echo mixed'],
			["double", "text = 'unterminated\n!echo mixed"],
		])("demotes an unterminated %s quote before a bang", async (_kind, code) => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", `prime-unterminated-${_kind}`, { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});

		it("does not demote a bang inside a continued single-quoted string", async () => {
			const cas = await makeCas();
			const code = String.raw`text = "continued \
!not shell"`;
			const source = await makeSource(cas, "ipython", "prime-continued-string-call", { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});
		it("rejects malformed CAS hashes before synthesizing eval, bash, or MIME output", async () => {
			const cas = await makeCas();
			const badHashes = [
				`${"a".repeat(32)}\n${"b".repeat(32)}`,
				`${"a".repeat(32)}\r${"b".repeat(32)}`,
				`${"a".repeat(32)}\u2028${"b".repeat(32)}`,
				`${"a".repeat(63)}\x01`,
			];
			for (const badHash of badHashes) {
				const ompSource = await makeSource(cas, "read", "omp-malformed-ref", { path: "README.md" });
				const primeEval = await makeSource(cas, "ipython", "prime-malformed-eval-ref", { code: "print('x')" });
				const primeShell = await makeSource(cas, "ipython", "prime-malformed-shell-ref", { code: "!echo x" });
				const unsupported = await makeSource(cas, "read", "omp-malformed-result-ref", { path: "file.pdf" }, [
					{ type: "mime", data: "JVBERi0xLjQ=", mimeType: "application/pdf" },
				]);

				await expect(
					mapOmpToolPair({
						...ompSource,
						pair: { ...ompSource.pair, originalCallRef: { hash: badHash } },
					}),
				).rejects.toThrow();
				await expect(
					mapPrimeToolPair({
						...primeEval,
						pair: { ...primeEval.pair, originalCallRef: { hash: badHash } },
					}),
				).rejects.toThrow();
				await expect(
					mapPrimeToolPair({
						...primeShell,
						pair: { ...primeShell.pair, originalCallRef: { hash: badHash } },
					}),
				).rejects.toThrow();
				await expect(
					mapOmpToolPair({
						...unsupported,
						pair: { ...unsupported.pair, resultRef: { hash: badHash } },
					}),
				).rejects.toThrow();
			}
		});
		it("keeps a bang inside a Python triple-quoted string in eval", async () => {
			const cas = await makeCas();
			const code = 'text = """\n!not shell\n"""';
			const source = await makeSource(cas, "ipython", "prime-string-bang-call", { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});
		it("treats triple quotes in a trailing Python comment as non-string syntax", async () => {
			const cas = await makeCas();
			const code = 'x = 1 # comment """\n!echo mixed';
			const source = await makeSource(cas, "ipython", "prime-comment-quote-call", { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});

		it("keeps a shell-looking line inside a string after an escaped triple delimiter", async () => {
			const cas = await makeCas();
			const code = String.raw`text = """prefix \""" still string
!not shell
"""`;
			const source = await makeSource(cas, "ipython", "prime-escaped-delimiter-call", { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});

		it("rejects malformed non-string Prime ipython code", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", "prime-malformed-code", { code: 42 });

			await expect(mapPrimeToolPair(source)).rejects.toThrow(/code/i);
		});

		it("keeps mixed Python and shell in eval and records semantic demotion", async () => {
			const cas = await makeCas();
			const code = "value = 2 + 2\n!printf '%s' $value";
			const source = await makeSource(cas, "ipython", "prime-mixed-call", { code });
			const mapped = await mapPrimeToolPair(source);
			const call = mapped.call as SynthesizedToolCall;
			const originalRef = source.pair.originalCallRef?.hash;
			if (!originalRef) throw new Error("missing original call CAS ref");

			expect(call).toMatchObject({
				name: "eval",
				arguments: { language: "py", code: expectedPrimeSource(originalRef, code) },
			});
			expect(mapped.result.toolName).toBe("eval");
			expect(mapped.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});
		it.each([
			["Python", "secret-python-token", { code: "print('secret-python-token')" }],
			["shell", "secret-shell-token", { code: "!printf secret-shell-token" }],
		])("does not embed arbitrary Prime %s source in synthesized payloads", async (_kind, secret, argsSnapshot) => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", `prime-secret-${_kind}`, argsSnapshot);
			const mapped = await mapPrimeToolPair(source);
			const serialized = JSON.stringify({ call: mapped.call, result: mapped.result });

			expect(serialized).not.toContain(secret);
			expect(await cas.read(mapped.pair.originalCallRef!)).toEqual(source.callBytes);
			expect(await cas.read(mapped.pair.resultRef!)).toEqual(source.resultBytes);
		});

		it("preserves images, errors, and IDs when synthesizing OMP results", async () => {
			const cas = await makeCas();
			const image = { type: "image" as const, data: "R0lGODlh", mimeType: "image/gif" };
			const source = await makeSource(cas, "ipython", "prime-image-call", { code: "print('x')" }, [image], true);
			const mapped = await mapPrimeToolPair(source);
			const result = mapped.result as SynthesizedToolResult;

			expect(result).toMatchObject({
				role: "toolResult",
				toolCallId: "prime-image-call",
				toolName: "eval",
				isError: true,
			});
			expect(resultContent(result)).toEqual([image]);
		});
		it("projects supported text and image blocks to fresh allowed shapes", async () => {
			const cas = await makeCas();
			const textBlock = { type: "text", text: "historical text", extra: "discarded" } as ToolBlock &
				Record<string, unknown>;
			const imageBlock = {
				type: "image",
				data: "R0lGODlh",
				mimeType: "image/gif",
				extra: "discarded",
			} as ToolBlock & Record<string, unknown>;

			for (const [toolName, block, expected] of [
				["read", textBlock, { type: "text", text: "historical text" }],
				["read", imageBlock, { type: "image", data: "R0lGODlh", mimeType: "image/gif" }],
			] as const) {
				const ompSource = await makeSource(cas, toolName, `omp-extra-${expected.type}`, {}, [block]);
				const primeSource = await makeSource(
					cas,
					"ipython",
					`prime-extra-prime-${expected.type}`,
					{ code: "print('x')" },
					[block],
				);
				const ompMapped = await mapOmpToolPair(ompSource);
				const primeMapped = await mapPrimeToolPair(primeSource);
				expect(resultContent(ompMapped.result)).toEqual([expected]);
				expect(resultContent(primeMapped.result)).toEqual([expected]);
				expect(ompMapped.losses).toEqual(
					expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
				);
				expect(primeMapped.losses).toEqual(
					expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
				);
				(block as Record<string, unknown>).text = "mutated";
				(block as Record<string, unknown>).data = "mutated";
				expect(resultContent(ompMapped.result)).toEqual([expected]);
				expect(resultContent(primeMapped.result)).toEqual([expected]);
			}
		});

		it("handles a large backslash-heavy triple string without demoting its bang line", async () => {
			const cas = await makeCas();
			const body = "\\".repeat(50_000);
			const code = `text = """\n${body}\n!not shell\n"""`;
			const source = await makeSource(cas, "ipython", "prime-large-triple-string", { code });
			const mapped = await mapPrimeToolPair(source);

			expect(mapped.call.name).toBe("eval");
			expect(mapped.losses).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable" })]),
			);
		});
		it("restores exact original Prime call and result bytes from CAS", async () => {
			const cas = await makeCas();
			const source = await makeSource(cas, "ipython", "prime-cas-call", { code: "print('cas')" });
			const mapped = await mapPrimeToolPair(source);

			expect(await cas.read(mapped.pair.originalCallRef!)).toEqual(source.callBytes);
			expect(await cas.read(mapped.pair.resultRef!)).toEqual(source.resultBytes);
			expect(mapped.pair.synthesizedCallRef).toBeDefined();
			expect(decoder.decode(await cas.read(mapped.pair.synthesizedCallRef!))).toContain(
				`# bridged:prime/ipython ${source.pair.originalCallRef?.hash}`,
			);
		});
	});
});
