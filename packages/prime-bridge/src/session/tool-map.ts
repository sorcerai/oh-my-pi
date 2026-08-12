import type { FileCas } from "./cas";
import { createLoss, type SessionLoss } from "./loss-ledger";
import type { CanonicalToolPair, JsonValue } from "./spec";
import {
	type SynthesizedArguments,
	type SynthesizedToolCall,
	type SynthesizedToolResult,
	serializeSynthesizedCall,
	synthesizeOmpHistoricalCode,
	synthesizePrimeShellCommand,
	synthesizePrimeSource,
	synthesizeResultContent,
} from "./tool-synthesis";

export interface HistoricalToolResult {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly JsonValue[];
	readonly isError: boolean;
}

export interface ToolMapInput {
	readonly pair: CanonicalToolPair;
	readonly result: HistoricalToolResult;
	readonly cas: FileCas;
}

export interface ToolMapOutput {
	readonly pair: CanonicalToolPair;
	readonly call: SynthesizedToolCall;
	readonly result: SynthesizedToolResult;
	readonly losses: readonly SessionLoss[];
}

function exactShellCommand(code: string): string | undefined {
	const lines = code.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	if (lines.length !== 1 || !lines[0].startsWith("!")) return undefined;
	const command = lines[0].slice(1);
	return command.trim().length === 0 ? undefined : command;
}
function hasUnquotedColumnZeroBang(code: string): boolean {
	let quote: "single" | "double" | "triple-single" | "triple-double" | undefined;
	let escaped = false;
	let lineStart = true;
	let comment = false;
	for (let index = 0; index < code.length; index++) {
		const character = code[index]!;
		if (comment) {
			if (character === "\n") {
				comment = false;
				lineStart = true;
			}
			continue;
		}
		if (quote === "triple-single" || quote === "triple-double") {
			const delimiter = quote === "triple-single" ? "'''" : '"""';
			if (code.startsWith(delimiter, index)) {
				let backslashes = 0;
				for (let previous = index - 1; previous >= 0 && code[previous] === "\\"; previous--) backslashes++;
				if (backslashes % 2 === 0) {
					quote = undefined;
					index += 2;
					lineStart = false;
					continue;
				}
			}
			lineStart = character === "\n";
			continue;
		}
		if (quote !== undefined) {
			const escapedCharacter = escaped;
			escaped = false;
			if (!escapedCharacter && character === "\\") escaped = true;
			else if (
				!escapedCharacter &&
				((quote === "single" && character === "'") || (quote === "double" && character === '"'))
			)
				quote = undefined;
			if (character === "\n") {
				if (!escapedCharacter) quote = undefined;
				lineStart = true;
			} else {
				lineStart = false;
			}
			continue;
		}
		if (lineStart && character === "!") return true;
		if (character === "#") {
			comment = true;
			lineStart = false;
			continue;
		}
		if (code.startsWith("'''", index)) {
			quote = "triple-single";
			index += 2;
			lineStart = false;
			continue;
		}
		if (code.startsWith('"""', index)) {
			quote = "triple-double";
			index += 2;
			lineStart = false;
			continue;
		}
		if (character === "'") quote = "single";
		else if (character === '"') quote = "double";
		lineStart = character === "\n";
	}
	return false;
}
function validCasHash(hash: string): boolean {
	return /^[0-9a-f]{64}$/.test(hash);
}

function codeFromSnapshot(argsSnapshot: JsonValue): string {
	if (typeof argsSnapshot !== "object" || argsSnapshot === null || Array.isArray(argsSnapshot)) {
		throw new Error("Prime ipython argsSnapshot must be an object with string code");
	}
	const value = argsSnapshot.code;
	if (typeof value !== "string") throw new Error("Prime ipython code must be a string");
	return value;
}
function validateCasRefs(input: ToolMapInput): void {
	for (const reference of [input.pair.originalCallRef, input.pair.resultRef]) {
		if (reference !== undefined && !validCasHash(reference.hash)) throw new Error("invalid CAS reference hash");
	}
}
function validateInput(input: ToolMapInput): void {
	if (input.pair.callId !== input.result.toolCallId) throw new Error("tool pair call ID mismatch");
	if (input.pair.toolName !== input.result.toolName) throw new Error("tool pair name mismatch");
}

function makeResult(
	input: ToolMapInput,
	toolName: string,
): { readonly result: SynthesizedToolResult; readonly losses: readonly SessionLoss[] } {
	const synthesizedContent = synthesizeResultContent(input.result.content, input.pair.resultRef?.hash);
	const losses = synthesizedContent.unsupportedBlocks.map(block =>
		createLoss(
			"entry_metadata_unrepresentable",
			`Unsupported ${block.kind === "mime" ? "MIME" : block.kind === "metadata" ? "metadata" : "content"} block: ${block.detail}`,
			undefined,
			"toolResult",
		),
	);
	if (input.pair.resultRef === undefined) {
		losses.push(
			createLoss("missing_source_bytes", "Tool result has no result CAS reference", undefined, "toolResult"),
		);
	}
	return {
		result: {
			role: "toolResult",
			toolCallId: input.result.toolCallId,
			toolName,
			content: synthesizedContent.content,
			isError: input.result.isError,
		},
		losses,
	};
}

export async function mapOmpToolPair(input: ToolMapInput): Promise<ToolMapOutput> {
	validateInput(input);
	validateCasRefs(input);
	const sourceRef = input.pair.originalCallRef?.hash ?? "missing";
	const code = synthesizeOmpHistoricalCode(input.pair.toolName, sourceRef, input.pair.argsSnapshot);
	const call: SynthesizedToolCall = { type: "toolCall", id: input.pair.callId, name: "ipython", arguments: { code } };
	const synthesizedCallRef = await input.cas.put(serializeSynthesizedCall(call));
	const mappedResult = makeResult(input, "ipython");
	const losses = [...mappedResult.losses];
	if (input.pair.originalCallRef === undefined)
		losses.push(createLoss("missing_source_bytes", "Original tool call has no CAS reference", undefined, "toolCall"));
	return {
		pair: { ...input.pair, synthesizedCallRef },
		call,
		result: mappedResult.result,
		losses,
	};
}

export async function mapPrimeToolPair(input: ToolMapInput): Promise<ToolMapOutput> {
	validateInput(input);
	validateCasRefs(input);
	const sourceRef = input.pair.originalCallRef?.hash ?? "missing";
	const code = codeFromSnapshot(input.pair.argsSnapshot);
	const normalizedCode = code.replace(/\r\n?/g, "\n");
	const shellCommand = exactShellCommand(normalizedCode);
	const targetName = shellCommand === undefined ? "eval" : "bash";
	const source =
		shellCommand === undefined
			? synthesizePrimeSource(sourceRef, code)
			: synthesizePrimeShellCommand(sourceRef, shellCommand);
	const argumentsValue: SynthesizedArguments =
		targetName === "bash" ? { command: source } : { language: "py", code: source };
	const call: SynthesizedToolCall = {
		type: "toolCall",
		id: input.pair.callId,
		name: targetName,
		arguments: argumentsValue,
	};
	const synthesizedCallRef = await input.cas.put(serializeSynthesizedCall(call));
	const mappedResult = makeResult(input, targetName);
	const losses = [...mappedResult.losses];
	if (input.pair.originalCallRef === undefined)
		losses.push(createLoss("missing_source_bytes", "Original tool call has no CAS reference", undefined, "toolCall"));
	if (shellCommand === undefined && hasUnquotedColumnZeroBang(normalizedCode)) {
		losses.push(
			createLoss(
				"entry_metadata_unrepresentable",
				"Mixed or multiple top-level shell lines were retained in an OMP eval call",
				undefined,
				"ipython",
			),
		);
	}
	return {
		pair: { ...input.pair, synthesizedCallRef },
		call,
		result: mappedResult.result,
		losses,
	};
}
