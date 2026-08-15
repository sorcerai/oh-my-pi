import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { type BridgeGrant, grantHasCapability, OMP_SUPERVISE_CAPABILITY } from "../grants";
import { type RegisteredTool, WORKER_SAFE_TOOLS } from "../protocol/tool-host";
import type { ToolHostServer } from "../tool-host/server";
import { mapAgentToolError, mapAgentToolResult } from "./result-map";

const MAX_MCP_BODY_BYTES = 1_048_576;
const MAX_MCP_RESPONSE_BYTES = 1_048_576;
const MCP_SERVER_INFO = { name: "prime-bridge", version: "1" } as const;
const MCP_ERROR_SESSION = -32001;

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function mcpError(id: unknown, code: number, message: string, status = 200): Response {
	return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<unknown> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0)
			throw new Error("content-length must be a non-negative integer");
	}
	if (request.body === null) throw new Error("request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > MAX_MCP_BODY_BYTES) throw new RangeError("request body is too large");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new SyntaxError("invalid JSON");
	}
}

async function enforceResponseLimit(response: Response): Promise<Response> {
	if (response.body === null) return response;
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_MCP_RESPONSE_BYTES) return jsonResponse({ error: "response body is too large" }, 413);
	return new Response(bytes, { status: response.status, headers: response.headers });
}

function toMcpTool(tool: RegisteredTool): Tool {
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema as Tool["inputSchema"],
	};
}

/**
 * A principal may call a tool when it holds `omp:supervise`, or when the tool is
 * on the worker-safe list. Everything else — the fleet lifecycle/apply/verify
 * surface — is supervisor-only, and unclassified tools are denied by default.
 */
function mayCallTool(principal: BridgeGrant, toolName: string): boolean {
	if (grantHasCapability(principal, OMP_SUPERVISE_CAPABILITY)) return true;
	return WORKER_SAFE_TOOLS.has(toolName);
}

export function validMcpSessionId(sessionId: string): boolean {
	return sessionId.length > 0 && sessionId.length <= 256 && !sessionId.includes("/") && sessionId.isWellFormed();
}

export async function handleMcpRequest(
	request: Request,
	toolHost: ToolHostServer,
	sessionId: string,
	principal: BridgeGrant,
): Promise<Response> {
	if (!validMcpSessionId(sessionId)) return mcpError(null, MCP_ERROR_SESSION, "invalid MCP session ID");

	let parsedBody: unknown;
	try {
		parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
	} catch (error) {
		return error instanceof RangeError
			? jsonResponse({ error: error.message }, 413)
			: mcpError(null, -32700, error instanceof Error ? error.message : String(error), 400);
	}
	const requestId = isRecord(parsedBody) ? parsedBody.id : null;
	const tools = toolHost.registry.getTools(sessionId).filter(tool => mayCallTool(principal, tool.name));
	if (!toolHost.registry.hasSession(sessionId))
		return mcpError(requestId, MCP_ERROR_SESSION, "MCP session is unknown or offline");
	let resultExceeded = false;
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });
	const inputValidator = new AjvJsonSchemaValidator();
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toMcpTool) }));
	server.setRequestHandler(CallToolRequestSchema, async (message, _extra) => {
		const tool = toolHost.registry.getTool(sessionId, message.params.name);
		const args = message.params.arguments ?? {};
		if (tool === undefined) return mapAgentToolError(new Error(`unknown tool: ${message.params.name}`));
		if (!mayCallTool(principal, message.params.name))
			return mapAgentToolError(new Error(`tool requires omp:supervise: ${message.params.name}`));
		const validation = inputValidator.getValidator(tool.inputSchema as unknown as JsonSchemaType)(args);
		if (!validation.valid) throw new McpError(ErrorCode.InvalidParams, validation.errorMessage);
		try {
			const mapped = mapAgentToolResult(await toolHost.callTool(sessionId, tool.name, args, request.signal));
			if (
				new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: mapped })).byteLength >
				MAX_MCP_RESPONSE_BYTES
			) {
				resultExceeded = true;
				return { content: [], isError: true };
			}
			return mapped;
		} catch (error) {
			return mapAgentToolError(error);
		}
	});
	let streaming = false;
	await server.connect(transport);
	try {
		const response = await transport.handleRequest(request, { parsedBody });
		if (response.body !== null && response.headers.get("content-type")?.includes("text/event-stream")) {
			const reader = response.body.getReader();
			let closed = false;
			let closePromise: Promise<void> | undefined;
			let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
			const closeResources = (): Promise<void> => {
				if (closePromise !== undefined) return closePromise;
				closed = true;
				request.signal.removeEventListener("abort", onAbort);
				try {
					responseController?.close();
				} catch {
					// The response stream may already be closed.
				}
				closePromise = (async () => {
					try {
						await reader.cancel();
					} catch {
						// The stream may already be canceled by the client.
					}
					await server.close();
				})();
				return closePromise;
			};
			const onAbort = (): void => {
				void closeResources();
			};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					responseController = controller;
					request.signal.addEventListener("abort", onAbort, { once: true });
					if (request.signal.aborted) {
						void closeResources();
						return;
					}
					controller.enqueue(new TextEncoder().encode(":\n\n"));
					void (async (): Promise<void> => {
						try {
							while (!closed) {
								const next = await reader.read();
								if (next.done) {
									if (!closed) controller.close();
									return;
								}
								if (!closed) controller.enqueue(next.value);
							}
						} catch (error) {
							if (!closed) controller.error(error);
						} finally {
							await closeResources();
						}
					})();
				},
				async cancel() {
					await closeResources();
				},
			});
			streaming = true;
			return new Response(stream, { status: response.status, headers: response.headers });
		}
		return resultExceeded
			? jsonResponse({ error: "response body is too large" }, 413)
			: await enforceResponseLimit(response);
	} finally {
		if (!streaming) await server.close();
	}
}
