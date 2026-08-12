import type { JsonValue } from "./spec";

export type SynthesizedArguments = { readonly [key: string]: JsonValue };

export interface SynthesizedToolCall {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly arguments: SynthesizedArguments;
}

export type SynthesizedTextBlock = { readonly type: "text"; readonly text: string };
export type SynthesizedImageBlock = {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
};
export type SynthesizedContentBlock = SynthesizedTextBlock | SynthesizedImageBlock;

export interface SynthesizedToolResult {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly SynthesizedContentBlock[];
	readonly isError: boolean;
}

export function synthesizeOmpHistoricalCode(toolName: string, originalRef: string, _argsSnapshot: JsonValue): string {
	const safeToolName = toolName.replace(/[^A-Za-z0-9_.-]/g, "_");
	return `# bridged:omp/${safeToolName} ${originalRef}`;
}

export function synthesizePrimeSource(originalRef: string, _code: string): string {
	return `# bridged:prime/ipython ${originalRef}`;
}

export function synthesizePrimeShellCommand(originalRef: string, _command: string): string {
	return `# bridged:prime/ipython ${originalRef}`;
}

export function serializeSynthesizedCall(call: SynthesizedToolCall): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(call));
}

function isImageBlock(value: JsonValue): value is SynthesizedImageBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	);
}
function isTextBlock(value: JsonValue): value is SynthesizedTextBlock {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		value.type === "text" &&
		typeof value.text === "string"
	);
}

function ownKeysOutside(value: { readonly [key: string]: JsonValue }, allowed: readonly string[]): boolean {
	return Object.keys(value).some(key => !allowed.includes(key));
}

/** Keep target-supported blocks and represent other blocks by their source CAS ref. */
export function synthesizeResultContent(
	content: readonly JsonValue[],
	resultRef: string | undefined,
): {
	readonly content: readonly SynthesizedContentBlock[];
	readonly unsupportedBlocks: readonly {
		readonly kind: "mime" | "unknown" | "metadata";
		readonly detail: string;
	}[];
} {
	const unsupportedBlocks: { kind: "mime" | "unknown" | "metadata"; detail: string }[] = [];
	const synthesized: SynthesizedContentBlock[] = [];

	for (const block of content) {
		if (isTextBlock(block)) {
			if (ownKeysOutside(block, ["type", "text"])) unsupportedBlocks.push({ kind: "metadata", detail: "text" });
			synthesized.push({ type: "text", text: block.text });
			continue;
		}
		if (isImageBlock(block)) {
			if (ownKeysOutside(block, ["type", "data", "mimeType"]))
				unsupportedBlocks.push({ kind: "metadata", detail: "image" });
			synthesized.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}

		const objectBlock = typeof block === "object" && block !== null && !Array.isArray(block) ? block : undefined;
		const mimeType =
			objectBlock !== undefined && typeof objectBlock.mimeType === "string" ? objectBlock.mimeType : undefined;
		const kind = mimeType === undefined ? "unknown" : "mime";
		const detail =
			mimeType ?? (objectBlock !== undefined && typeof objectBlock.type === "string" ? objectBlock.type : "unknown");
		unsupportedBlocks.push({ kind, detail });
		const source = resultRef === undefined ? "source unavailable" : `source CAS ${resultRef}`;
		synthesized.push({
			type: "text",
			text: `[unsupported ${kind === "mime" ? `MIME ${detail}` : `content block ${detail}`}; ${source}]`,
		});
	}

	return { content: synthesized, unsupportedBlocks };
}
