import { type Type, type } from "@oh-my-pi/omptype";

export interface McpTextContent {
	type: "text";
	text: string;
}

export interface McpImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface McpToolResult {
	content: (McpTextContent | McpImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface RegisteredTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolHostFrame =
	| {
			readonly type: "register";
			readonly hostId: string;
			readonly sessionId: string;
			readonly tools: readonly RegisteredTool[];
	  }
	| { readonly type: "tools_changed"; readonly sessionId: string; readonly tools: readonly RegisteredTool[] }
	| { readonly type: "cancel_tool"; readonly requestId: string; readonly sessionId: string }
	| {
			readonly type: "call_tool";
			readonly requestId: string;
			readonly sessionId: string;
			readonly toolName: string;
			readonly arguments: unknown;
	  }
	| { readonly type: "tool_result"; readonly requestId: string; readonly result: McpToolResult }
	| { readonly type: "tool_error"; readonly requestId: string; readonly code: string; readonly message: string }
	| { readonly type: "unregister"; readonly sessionId: string };

const nonEmptyString = type("string").atLeastLength(1);
const jsonObjectSchema = type("object").narrow(value => !Array.isArray(value));
const registeredToolSchema = type({
	name: nonEmptyString,
	"description?": "string",
	inputSchema: jsonObjectSchema,
});
const textContentSchema = type({ type: "'text'", text: "string" });
const imageContentSchema = type({ type: "'image'", data: "string", mimeType: "string" });
const mcpToolResultSchema = type({
	content: textContentSchema.or(imageContentSchema).array(),
	"details?": "unknown",
	"isError?": "boolean",
});

const registerFrameSchema = type({
	type: "'register'",
	hostId: nonEmptyString,
	sessionId: nonEmptyString,
	tools: registeredToolSchema.array(),
});
const toolsChangedFrameSchema = type({
	type: "'tools_changed'",
	sessionId: nonEmptyString,
	tools: registeredToolSchema.array(),
});
const callToolFrameSchema = type({
	type: "'call_tool'",
	requestId: nonEmptyString,
	sessionId: nonEmptyString,
	toolName: nonEmptyString,
	arguments: "unknown",
});
const toolResultFrameSchema = type({
	type: "'tool_result'",
	requestId: nonEmptyString,
	result: mcpToolResultSchema,
});
const toolErrorFrameSchema = type({
	type: "'tool_error'",
	requestId: nonEmptyString,
	code: nonEmptyString,
	message: "string",
});
const cancelToolFrameSchema = type({
	type: "'cancel_tool'",
	requestId: nonEmptyString,
	sessionId: nonEmptyString,
});
const unregisterFrameSchema = type({
	type: "'unregister'",
	sessionId: nonEmptyString,
});

const frameSchema = registerFrameSchema
	.or(toolsChangedFrameSchema)
	.or(callToolFrameSchema)
	.or(toolResultFrameSchema)
	.or(toolErrorFrameSchema)
	.or(cancelToolFrameSchema)
	.or(unregisterFrameSchema);

export const toolHostFrameSchema = frameSchema as unknown as Type<ToolHostFrame>;
export const ToolHostFrameSchema = toolHostFrameSchema;

function parseInput(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error(`Invalid tool host frame JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function parseToolHostFrame(value: unknown): ToolHostFrame {
	return toolHostFrameSchema.assert(parseInput(value));
}

export function isToolHostFrame(value: unknown): value is ToolHostFrame {
	try {
		parseToolHostFrame(value);
		return true;
	} catch {
		return false;
	}
}
