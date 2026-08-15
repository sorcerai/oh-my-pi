import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import { handleMcpRequest } from "../src/mcp/server";
import type { ToolHostFrame } from "../src/protocol/tool-host";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

type Tool = Extract<ToolHostFrame, { type: "register" }>["tools"][number];
const SUPERVISOR = { principal: "omp", role: "supervisor", sessions: [], capabilities: [] } as const;

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

async function createServer(allowedOrigins: readonly string[] = []): Promise<PrimeBridgeServer> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-mcp-"));
	temporaryDirectories.push(stateDir);
	const config = resolveBridgeConfig({
		stateDir,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		allowedOrigins,
		port: 0,
	});
	const server = await startPrimeBridgeServer({ config, peers: () => [] });
	runningServers.push(server);
	return server;
}

async function cleanup(): Promise<void> {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
}

afterEach(cleanup);

function connectHost(server: PrimeBridgeServer): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const socket = new WebSocket(`${server.url}/v1/tool-host`, { headers: { Authorization: `Bearer ${server.token}` } });
	socket.addEventListener("open", () => resolve(socket), { once: true });
	socket.addEventListener("error", () => reject(new Error("host websocket failed")), { once: true });
	return promise;
}

function nextHostFrame(socket: WebSocket): Promise<ToolHostFrame> {
	const { promise, resolve } = Promise.withResolvers<ToolHostFrame>();
	socket.addEventListener("message", event => resolve(JSON.parse(String(event.data)) as ToolHostFrame), {
		once: true,
	});
	return promise;
}

function register(socket: WebSocket, sessionId: string, tool: Tool): void {
	socket.send(JSON.stringify({ type: "register", hostId: `host-${sessionId}`, sessionId, tools: [tool] }));
}

async function waitForSession(server: PrimeBridgeServer, sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (server.toolHost.registry.hasSession(sessionId)) return;
		// WebSocket registration is delivered by Bun on the platform event loop.
		await Bun.sleep(5);
	}
	throw new Error(`session did not register: ${sessionId}`);
}

async function mcp(
	server: PrimeBridgeServer,
	sessionId: string,
	body: unknown,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(`${server.url}/mcp/v1/sessions/${encodeURIComponent(sessionId)}`, {
		...init,
		method: "POST",
		headers: {
			Authorization: `Bearer ${server.token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(init.headers ?? {}),
		},
		body: JSON.stringify(body),
	});
}

async function json(response: Response): Promise<JsonRpcResponse> {
	return (await response.json()) as JsonRpcResponse;
}

const readTool = (description: string): Tool => ({
	name: "read",
	description,
	inputSchema: {
		type: "object",
		properties: {
			path: {
				oneOf: [
					{ type: "string", minLength: 1 },
					{ type: "number", minimum: 1 },
				],
			},
		},
		required: ["path"],
	},
});

async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const closed = Promise.withResolvers<void>();
	socket.addEventListener("close", () => closed.resolve(), { once: true });
	socket.close();
	await closed.promise;
}

describe("session-scoped MCP Streamable HTTP endpoint", () => {
	it("applies bearer and Origin policy", async () => {
		const server = await createServer(["https://trusted.example"]);
		const route = `${server.url}/mcp/v1/sessions/session-a`;
		const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

		expect(
			(
				await fetch(route, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
					body: JSON.stringify(body),
				})
			).status,
		).toBe(401);
		expect(
			(
				await fetch(route, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${server.token}`,
						Origin: "https://untrusted.example",
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify(body),
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(route, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${server.token}`,
						Origin: "https://trusted.example",
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify(body),
				})
			).status,
		).toBe(200);
	});

	it("initializes with tools-only capabilities", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("session a"));
		await waitForSession(server, "session-a");

		const response = await mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		});
		const payload = await json(response);
		expect(payload.result?.capabilities).toEqual({ tools: {} });
		expect(payload.result).not.toHaveProperty("capabilities.resources");
		await closeSocket(host);
	});
	it("negotiates an older supported initialize protocol version", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("session a"));
		await waitForSession(server, "session-a");

		const response = await mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		});
		expect((await json(response)).result?.protocolVersion).toBe("2025-03-26");
		await closeSocket(host);
	});
	it("serves an SSE GET and closes it when canceled", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("session a"));
		await waitForSession(server, "session-a");

		const requestController = new AbortController();
		const response = await handleMcpRequest(
			new Request(`${server.url}/mcp/v1/sessions/session-a`, {
				headers: { Accept: "text/event-stream" },
				signal: requestController.signal,
			}),
			server.toolHost,
			"session-a",
			SUPERVISOR,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe(":\n\n");
		await reader?.cancel();

		const abortedResponse = await handleMcpRequest(
			new Request(`${server.url}/mcp/v1/sessions/session-a`, {
				headers: { Accept: "text/event-stream" },
				signal: requestController.signal,
			}),
			server.toolHost,
			"session-a",
			SUPERVISOR,
		);
		requestController.abort();
		await abortedResponse.body?.cancel();
		await closeSocket(host);
	});

	it("returns an MCP error for unknown and offline sessions", async () => {
		const server = await createServer();
		const unknown = await mcp(server, "missing", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect((await json(unknown)).error?.code).toBe(-32001);

		const host = await connectHost(server);
		register(host, "session-a", readTool("online"));
		await waitForSession(server, "session-a");
		await closeSocket(host);
		// Wait for Bun to deliver the WebSocket close to the host registry.
		const offline = await mcp(server, "session-a", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect((await json(offline)).error?.code).toBe(-32001);
	});

	it("isolates tools/list by exact session ID", async () => {
		const server = await createServer();
		const first = await connectHost(server);
		const second = await connectHost(server);
		register(first, "session-a", readTool("first"));
		register(second, "session-b", readTool("second"));
		await waitForSession(server, "session-a");
		await waitForSession(server, "session-b");

		const firstResult = await json(
			await mcp(server, "session-a", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		);
		const secondResult = await json(
			await mcp(server, "session-b", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		);
		expect(firstResult.result?.tools).toEqual([readTool("first")]);
		expect(secondResult.result?.tools).toEqual([readTool("second")]);
		await closeSocket(first);
		await closeSocket(second);
	});

	it("rejects invalid tool arguments", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("read"));
		await waitForSession(server, "session-a");
		const response = await mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "read", arguments: { path: "" } },
		});

		expect((await json(response)).error?.code).toBe(-32602);
		await closeSocket(host);
	});

	it("maps host JSON, text, and image results without loss", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("read"));
		await waitForSession(server, "session-a");
		const pending = mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "read", arguments: { path: "x" } },
		});
		const call = await nextHostFrame(host);
		if (call.type !== "call_tool") throw new Error("expected tool call");
		host.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: {
					content: [
						{ type: "text", text: "first" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						{ type: "text", text: "last" },
					],
					details: { answer: 42 },
				},
			}),
		);
		const payload = await json(await pending);
		expect(payload.result).toEqual({
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: "last" },
			],
			structuredContent: { answer: 42 },
		});
		await closeSocket(host);
	});

	it("maps host tool_error as isError true", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("read"));
		await waitForSession(server, "session-a");
		const pending = mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "read", arguments: { path: "x" } },
		});
		const call = await nextHostFrame(host);
		if (call.type !== "call_tool") throw new Error("expected tool call");
		host.send(
			JSON.stringify({ type: "tool_error", requestId: call.requestId, code: "failed", message: "tool failed" }),
		);
		expect((await json(await pending)).result).toEqual({
			content: [{ type: "text", text: "failed: tool failed" }],
			isError: true,
		});
		await closeSocket(host);
	});

	it("enforces one MiB request and response limits", async () => {
		const server = await createServer();
		const oversized = await mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { padding: "x".repeat(1_048_576) },
		});
		expect(oversized.status).toBe(413);

		const host = await connectHost(server);
		register(host, "session-a", readTool("read"));
		await waitForSession(server, "session-a");
		const pending = mcp(server, "session-a", {
			jsonrpc: "2.0",
			id: "x".repeat(100),
			method: "tools/call",
			params: { name: "read", arguments: { path: "x" } },
		});
		const call = await nextHostFrame(host);
		if (call.type !== "call_tool") throw new Error("expected tool call");
		host.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "x".repeat(1_048_450) }] },
			}),
		);
		const resultResponse = await pending;
		expect(resultResponse.status).toBe(413);
		await closeSocket(host);
	});
	it("passes HTTP disconnect cancellation to the host", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		register(host, "session-a", readTool("read"));
		await waitForSession(server, "session-a");
		const controller = new AbortController();
		const pending = mcp(
			server,
			"session-a",
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { path: "x" } } },
			{ signal: controller.signal },
		);
		const pendingOutcome = pending.catch(error => error);
		const call = await nextHostFrame(host);
		if (call.type !== "call_tool") throw new Error("expected tool call");
		controller.abort();
		const cancel = await nextHostFrame(host);
		expect(cancel).toMatchObject({ type: "cancel_tool", sessionId: "session-a" });
		const outcome = await pendingOutcome;
		expect(outcome).toBeInstanceOf(Error);
		await closeSocket(host);
	});
});
