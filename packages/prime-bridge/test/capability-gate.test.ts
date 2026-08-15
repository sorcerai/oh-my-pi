/**
 * The tool-layer authority gate — the property the whole grant model exists to
 * enforce and that a session-allowlist alone cannot provide.
 *
 * A worker grant may address only its granted sessions, but it must also be
 * unable to *call* the supervisor-only tool surface (fleet_spawn/kill/verify/
 * apply) that the session registers. This is the Phase-3 blocker: role/session
 * scope reached the MCP session boundary but never the tool list.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import type { PrimeBridgeServer } from "../src/server";
import { startPrimeBridgeServer } from "../src/server";
import { WORKER_SAFE_TOOLS } from "../src/protocol/tool-host";
import type { ToolHostFrame } from "../src/protocol/tool-host";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

const SUPERVISOR_TOKEN = "supervisor-token-value";
const WORKER_TOKEN = "worker-token-value";
const SCOPED_SUPERVISOR_TOKEN = "scoped-supervisor-token-value";
const GRANTED_SESSION = "sess-granted";

type Tool = Extract<ToolHostFrame, { type: "register" }>["tools"][number];

const fleetSpawnTool: Tool = {
	name: "fleet_spawn",
	description: "Spawn a model agent (supervisor-only)",
	inputSchema: { type: "object", properties: { model: { type: "string" } }, required: ["model"] },
};
const readTool: Tool = {
	name: "read",
	description: "Read a file",
	inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

async function createServer(): Promise<PrimeBridgeServer> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-capability-"));
	temporaryDirectories.push(stateDir);
	const tokenFile = path.join(stateDir, "token");
	await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(
		tokenFile,
		JSON.stringify({
			[SUPERVISOR_TOKEN]: { principal: "omp", role: "supervisor" },
			[WORKER_TOKEN]: { principal: "plain-worker", role: "worker", sessions: [GRANTED_SESSION] },
			[SCOPED_SUPERVISOR_TOKEN]: {
				principal: "cyboflow",
				role: "worker",
				sessions: [GRANTED_SESSION],
				capabilities: ["omp:supervise"],
			},
		}),
		{ mode: 0o600 },
	);
	const config = resolveBridgeConfig({
		stateDir,
		tokenFile,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		port: 0,
	});
	const server = await startPrimeBridgeServer({ config, peers: () => [] });
	runningServers.push(server);
	return server;
}

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function connectHost(server: PrimeBridgeServer): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const socket = new WebSocket(`${server.url}/v1/tool-host`, {
		headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
	});
	// Answer call_tool frames so a tools/call resolves instead of hanging.
	socket.addEventListener("message", event => {
		const frame = JSON.parse(String(event.data)) as ToolHostFrame;
		if (frame.type === "call_tool") {
			socket.send(
				JSON.stringify({
					type: "tool_result",
					requestId: frame.requestId,
					result: { content: [{ type: "text", text: "ok" }] },
				}),
			);
		}
	});
	socket.addEventListener("open", () => resolve(socket), { once: true });
	socket.addEventListener("error", () => reject(new Error("host websocket failed")), { once: true });
	return promise;
}

async function waitForSession(server: PrimeBridgeServer, sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (server.toolHost.registry.hasSession(sessionId)) return;
		await Bun.sleep(5);
	}
	throw new Error(`session did not register: ${sessionId}`);
}

async function mcp(
	server: PrimeBridgeServer,
	sessionId: string,
	token: string,
	method: "tools/list" | "tools/call",
	params: Record<string, unknown> = {},
): Promise<Response> {
	return fetch(`${server.url}/mcp/v1/sessions/${encodeURIComponent(sessionId)}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

describe("tool-layer authority gate", () => {
	it("hides supervisor-only tools from a plain worker's tools/list", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		host.send(
			JSON.stringify({
				type: "register",
				hostId: "host-1",
				sessionId: GRANTED_SESSION,
				tools: [readTool, fleetSpawnTool],
			}),
		);
		await waitForSession(server, GRANTED_SESSION);

		const response = await mcp(server, GRANTED_SESSION, WORKER_TOKEN, "tools/list");
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { result?: { tools?: { name: string }[] } };
		const names = (payload.result?.tools ?? []).map(tool => tool.name);
		expect(names).toContain("read");
		expect(names).not.toContain("fleet_spawn");
		host.close();
	});

	it("denies a plain worker calling a supervisor-only tool", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		host.send(
			JSON.stringify({
				type: "register",
				hostId: "host-1",
				sessionId: GRANTED_SESSION,
				tools: [fleetSpawnTool],
			}),
		);
		await waitForSession(server, GRANTED_SESSION);

		const response = await mcp(server, GRANTED_SESSION, WORKER_TOKEN, "tools/call", {
			name: "fleet_spawn",
			arguments: { model: "m" },
		});
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { result?: { isError?: boolean } };
		expect(payload.result?.isError).toBe(true);
		host.close();
	});

	it("lets a scoped supervisor (worker + omp:supervise) call a supervisor-only tool", async () => {
		const server = await createServer();
		const host = await connectHost(server);
		host.send(
			JSON.stringify({
				type: "register",
				hostId: "host-1",
				sessionId: GRANTED_SESSION,
				tools: [fleetSpawnTool],
			}),
		);
		await waitForSession(server, GRANTED_SESSION);

		// tools/list exposes the supervisor-only tool to the scoped supervisor.
		const list = await mcp(server, GRANTED_SESSION, SCOPED_SUPERVISOR_TOKEN, "tools/list");
		const listPayload = (await list.json()) as { result?: { tools?: { name: string }[] } };
		expect((listPayload.result?.tools ?? []).map(tool => tool.name)).toContain("fleet_spawn");

		// tools/call is not denied at the authority layer: it reaches the tool host
		// and returns a successful result, whereas a plain worker is denied before
		// the host is touched.
		const call = await mcp(server, GRANTED_SESSION, SCOPED_SUPERVISOR_TOKEN, "tools/call", {
			name: "fleet_spawn",
			arguments: { model: "m" },
		});
		const callPayload = (await call.json()) as { result?: { isError?: boolean } };
		expect(callPayload.result?.isError).not.toBe(true);
		host.close();
	});

	it("scoped supervisor is still session-scoped, not an unscoped supervisor", async () => {
		const server = await createServer();
		// No host has registered any session; authority answers before liveness.
		expect((await mcp(server, "sess-ungranted", SCOPED_SUPERVISOR_TOKEN, "tools/list")).status).toBe(403);
		expect((await mcp(server, "sess-ungranted", SUPERVISOR_TOKEN, "tools/list")).status).not.toBe(403);
	});

	it("worker-safe set is exactly the read/grep/glob/web_search surface", () => {
		expect([...WORKER_SAFE_TOOLS].sort()).toEqual(["glob", "grep", "read", "web_search"].sort());
	});
});
