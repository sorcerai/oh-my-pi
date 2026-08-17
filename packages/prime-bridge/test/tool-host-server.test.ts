import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import type { ToolHostFrame } from "../src/protocol/tool-host";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";
import { BridgeStore } from "../src/store";
import {
	drainToolHostFrames,
	heartbeatToolHostSocket,
	sendToolHostFrame,
	TOOL_HOST_CALL_TIMEOUT_MS,
	type ToolHostHeartbeatSocket,
	type ToolHostOutboundState,
	type ToolHostSendStatus,
	ToolHostServer,
} from "../src/tool-host/server";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];
const tool = {
	name: "read",
	description: "Read a file",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

async function createServer(overrides: Record<string, unknown> = {}): Promise<PrimeBridgeServer> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-tool-host-"));
	temporaryDirectories.push(stateDir);
	const config = resolveBridgeConfig({
		stateDir,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		port: 0,
		...(overrides.allowedOrigins === undefined
			? {}
			: { allowedOrigins: overrides.allowedOrigins as readonly string[] }),
	});
	const server = await startPrimeBridgeServer({
		config,
		peers: () => [],
		...(overrides.toolHost === undefined ? {} : { toolHost: overrides.toolHost as never }),
	});
	runningServers.push(server);
	return server;
}
async function stopResources(): Promise<void> {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
}
afterEach(stopResources);
function connect(server: PrimeBridgeServer, headers: Record<string, string> = {}): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`${server.url}/v1/tool-host`, {
		headers: { Authorization: `Bearer ${server.token}`, ...headers },
	});
	ws.addEventListener("open", () => resolve(ws), { once: true });
	ws.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
	return promise;
}
function nextMessage(ws: WebSocket, timeoutMs = 1_000): Promise<ToolHostFrame> {
	const { promise, resolve, reject } = Promise.withResolvers<ToolHostFrame>();
	const timer = setTimeout(() => reject(new Error("timed out waiting for websocket message")), timeoutMs);
	ws.addEventListener(
		"message",
		event => {
			clearTimeout(timer);
			resolve(JSON.parse(String(event.data)) as ToolHostFrame);
		},
		{ once: true },
	);
	return promise;
}
function registration(sessionId = "session-a", hostId = "host-a"): ToolHostFrame {
	return { type: "register", hostId, sessionId, tools: [tool] };
}
async function closeSocket(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	ws.addEventListener("close", () => resolve(), { once: true });
	ws.close();
	return promise;
}

describe("authenticated tool host websocket endpoint", () => {
	it("rejects missing and invalid bearer credentials", async () => {
		const server = await createServer();
		const route = `${server.url}/v1/tool-host`;
		expect((await fetch(route)).status).toBe(401);
		expect((await fetch(route, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
	});
	it("rejects a disallowed Origin before websocket upgrade", async () => {
		const server = await createServer();
		const response = await fetch(`${server.url}/v1/tool-host`, {
			headers: { Authorization: `Bearer ${server.token}`, Origin: "https://untrusted.example" },
		});
		expect(response.status).toBe(403);
	});
	it("registers an authenticated host and records an audit preview without arguments", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(server.toolHost.registry.getTools("session-a")).toEqual([tool]);
		expect(server.toolHost.audit().some(entry => entry.action === "register")).toBe(true);
		expect(JSON.stringify(server.toolHost.audit())).not.toContain("arguments");
		await closeSocket(ws);
	});
	it("removes a host after its heartbeat connection closes", async () => {
		const server = await createServer({ toolHost: { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 25 } });
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		ws.close();
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(ws.readyState).toBe(WebSocket.CLOSED);
		expect(server.toolHost.registry.hasSession("session-a")).toBe(false);
	});
	it("clears the host registry when liveness is interrupted", async () => {
		const server = await createServer({ toolHost: { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 25 } });
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		ws.terminate();
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(server.toolHost.registry.hasSession("session-a")).toBe(false);
	});
	it("keeps a healthy client connected across multiple heartbeat intervals", async () => {
		const server = await createServer({ toolHost: { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 25 } });
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 70));
		expect(ws.readyState).toBe(WebSocket.OPEN);
		expect(server.toolHost.registry.hasSession("session-a")).toBe(true);
		await closeSocket(ws);
	});
	it("rejects an inbound frame larger than one MiB", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(
			JSON.stringify({ type: "register", hostId: "h", sessionId: "s", tools: [], padding: "x".repeat(1_048_576) }),
		);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(ws.readyState).toBe(WebSocket.CLOSED);
	});
	it("correlates outbound calls with result and error frames", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		const resultPromise = server.toolHost.callTool("session-a", "read", { path: "README.md" });
		const call = await nextMessage(ws);
		expect(call).toMatchObject({ type: "call_tool", sessionId: "session-a", toolName: "read" });
		if (call.type !== "call_tool") throw new Error("expected call frame");
		ws.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		);
		expect(await resultPromise).toEqual({ content: [{ type: "text", text: "ok" }] });
		await closeSocket(ws);
	});
	it("does not allow a different session to spoof a pending result", async () => {
		const server = await createServer();
		const first = await connect(server);
		const second = await connect(server);
		first.send(JSON.stringify(registration("session-a", "host-a")));
		second.send(JSON.stringify(registration("session-b", "host-b")));
		await new Promise(resolve => setTimeout(resolve, 20));
		const pending = server.toolHost.callTool("session-a", "read", { path: "README.md" });
		const call = await nextMessage(first);
		if (call.type !== "call_tool") throw new Error("expected call frame");
		second.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "spoof" }] },
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(await Promise.race([pending.then(() => "resolved"), Promise.resolve("pending")])).toBe("pending");
		first.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		);
		await expect(pending).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
		await closeSocket(first);
		await closeSocket(second);
	});
	it("fails a pending call when the owner is replaced and ignores stale-owner replies", async () => {
		const server = await createServer();
		const oldSocket = await connect(server);
		oldSocket.send(JSON.stringify(registration("session-a", "old-host")));
		await new Promise(resolve => setTimeout(resolve, 20));
		const pending = server.toolHost.callTool("session-a", "read", { path: "README.md" });
		const call = await nextMessage(oldSocket);
		if (call.type !== "call_tool") throw new Error("expected call frame");
		const newSocket = await connect(server);
		newSocket.send(JSON.stringify(registration("session-a", "new-host")));
		await expect(pending).rejects.toThrow(/disconnect/);
		oldSocket.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "stale" }] },
			}),
		);
		expect(server.toolHost.audit().filter(entry => entry.action === "result")).toHaveLength(0);
		await closeSocket(newSocket);
	});
	it("fails pending calls when the host disconnects and records disconnect audit", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		const pending = server.toolHost.callTool("session-a", "read", { path: "README.md" });
		await nextMessage(ws);
		await closeSocket(ws);
		await expect(pending).rejects.toThrow(/disconnect|closed/i);
		expect(server.toolHost.audit().some(entry => entry.action === "disconnect")).toBe(true);
	});
	it("rejects same-socket re-registration", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration("session-a", "host-a")));
		await new Promise(resolve => setTimeout(resolve, 20));
		ws.send(JSON.stringify(registration("session-b", "host-b")));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(ws.readyState).toBe(WebSocket.CLOSED);
		expect(server.toolHost.registry.hasSession("session-b")).toBe(false);
	});
	it("persists supplied-host result and error audits without secrets", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		const pending = server.toolHost.callTool("session-a", "read", { secret: "argument-secret" });
		const call = await nextMessage(ws);
		if (call.type !== "call_tool") throw new Error("expected call");
		ws.send(
			JSON.stringify({
				type: "tool_result",
				requestId: call.requestId,
				result: { content: [{ type: "text", text: "result-secret" }] },
			}),
		);
		await pending;
		const failed = server.toolHost.callTool("session-a", "read", {});
		const errorCall = await nextMessage(ws);
		if (errorCall.type !== "call_tool") throw new Error("expected call");
		ws.send(
			JSON.stringify({ type: "tool_error", requestId: errorCall.requestId, code: "NOPE", message: "error-secret" }),
		);
		await expect(failed).rejects.toThrow(/NOPE/);
		await closeSocket(ws);
		const rows = (await (
			await fetch(`${server.url}/v1/audit`, { headers: { Authorization: `Bearer ${server.token}` } })
		).json()) as Array<{ action: string; preview: unknown }>;
		expect(rows.map(row => row.action)).toEqual(
			expect.arrayContaining([
				"tool_host_register",
				"tool_host_call",
				"tool_host_result",
				"tool_host_error",
				"tool_host_disconnect",
			]),
		);
		const auditJson = JSON.stringify(rows);
		expect(auditJson).not.toContain("argument-secret");
		expect(auditJson).not.toContain("result-secret");
		expect(auditJson).not.toContain("error-secret");
	});
	it("persists audits from a supplied host and bounds in-memory retention", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-supplied-host-"));
		temporaryDirectories.push(stateDir);
		const store = BridgeStore.open(path.join(stateDir, "bridge.sqlite"));
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const config = resolveBridgeConfig({
			stateDir,
			primeConfigFile: path.join(stateDir, "omp-bridge.json"),
			port: 0,
		});
		const server = await startPrimeBridgeServer({ config, store, toolHost: host, peers: () => [] });
		runningServers.push(server);
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(store.listAudit().some(entry => entry.action === "tool_host_register")).toBe(true);
		await closeSocket(ws);
		for (let index = 0; index < 1_001; index += 1) {
			const fake = {
				data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
				readyState: 1,
				sendText: () => 1,
				ping: () => {},
				terminate: () => {},
				close: () => {},
			} as never;
			host.websocket.open?.(fake);
			host.websocket.message(fake, JSON.stringify(registration(`retained-${index}`, `host-${index}`)));
		}
		expect(host.audit()).toHaveLength(1_000);
		expect(host.audit()[0]?.sessionId).toBe("retained-1");
		await server.stop();
		store.close();
	});
	it("awaited stop closes the listener", async () => {
		const server = await createServer();
		await server.stop();
		await expect(fetch(`${server.url}/health`)).rejects.toThrow();
	});
	it("handles outbound backpressure without duplication and enforces queue limits", () => {
		const state: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		const sent: string[] = [];
		sendToolHostFrame(
			state,
			text => {
				sent.push(text);
				return -1;
			},
			"first",
		);
		sendToolHostFrame(
			state,
			text => {
				sent.push(text);
				return 1;
			},
			"second",
		);
		expect(sent).toEqual(["first"]);
		expect(state.queue).toEqual([{ text: "second", accepted: false }]);
		drainToolHostFrames(state, text => {
			sent.push(text);
			return -1;
		});
		expect(sent).toEqual(["first", "second"]);
		expect(state.queue).toEqual([]);
		const dropped: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		expect(() => sendToolHostFrame(dropped, () => 0, "dropped")).toThrow(/dropped/);
		state.backpressured = true;
		for (let index = 0; index < 100; index += 1) sendToolHostFrame(state, () => 1, `q${index}`);
		expect(() => sendToolHostFrame(state, () => 1, "overflow")).toThrow(/full/);
	});
	it("accepts an exactly one MiB outbound frame", () => {
		const state: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		const frame = "x".repeat(1_048_576);
		expect(sendToolHostFrame(state, () => 1, frame)).toBe(true);
		expect(state.queue).toHaveLength(0);
	});
	it("rejects an outbound frame larger than one MiB without sending or queueing", () => {
		const state: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		let sends = 0;
		const frame = "x".repeat(1_048_577);
		expect(() =>
			sendToolHostFrame(
				state,
				() => {
					sends += 1;
					return 1;
				},
				frame,
			),
		).toThrow(/too large/);
		expect(sends).toBe(0);
		expect(state.queue).toEqual([]);
		expect(state.queuedBytes).toBe(0);
	});
	it("drops generic frames when drain reports status zero", () => {
		const state: ToolHostOutboundState = {
			queue: [{ text: "generic", accepted: false }],
			queuedBytes: "generic".length,
			backpressured: true,
		};
		const sent: string[] = [];
		drainToolHostFrames(state, text => {
			sent.push(text);
			return 0;
		});
		expect(sent).toEqual(["generic"]);
		expect(state.queue).toEqual([]);
		expect(state.queuedBytes).toBe(0);
	});
	it("rejects a queued call immediately when drain reports status zero", async () => {
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const data: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		const sent: string[] = [];
		const fake = {
			data,
			readyState: 1,
			sendText(text: string): ToolHostSendStatus {
				sent.push(text);
				return sent.length === 1 ? -1 : 0;
			},
			ping: () => {},
			terminate: () => {},
			close: () => {},
		} as never;
		const websocket = host.websocket;
		websocket.open?.(fake);
		websocket.message(fake, JSON.stringify(registration()));
		const first = host.callTool("session-a", "read", {});
		const firstCall = JSON.parse(sent[0]!) as { requestId: string };
		websocket.message(
			fake,
			JSON.stringify({ type: "tool_result", requestId: firstCall.requestId, result: { content: [] } }),
		);
		await first;
		const second = host.callTool("session-a", "read", {});
		websocket.drain?.(fake);
		await expect(second).rejects.toThrow(/dropped/);
		expect(data.queue).toEqual([]);
		host.close();
	});
	it("cleans up the tool error timer after terminal error", async () => {
		vi.useFakeTimers();
		try {
			const host = new ToolHostServer({ callTimeoutMs: 10, heartbeatIntervalMs: 1_000_000 });
			const sent: string[] = [];
			let closed = false;
			const fake = {
				data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
				readyState: 1,
				sendText(text: string): ToolHostSendStatus {
					sent.push(text);
					return 1;
				},
				ping: () => {},
				terminate: () => {},
				close: () => {
					closed = true;
				},
			} as never;
			const websocket = host.websocket;
			websocket.open?.(fake);
			websocket.message(fake, JSON.stringify(registration()));
			const timerCountBeforeCall = vi.getTimerCount();
			const pending = host.callTool("session-a", "read", {});
			expect(vi.getTimerCount()).toBe(timerCountBeforeCall + 1);
			const call = JSON.parse(sent[0]!) as { requestId: string };
			websocket.message(
				fake,
				JSON.stringify({ type: "tool_error", requestId: call.requestId, code: "FAILED", message: "terminal" }),
			);
			await expect(pending).rejects.toThrow(/FAILED/);
			expect(vi.getTimerCount()).toBe(timerCountBeforeCall);
			vi.advanceTimersByTime(20);
			expect(closed).toBe(false);
			host.close();
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps the default tool call pending through the adapter deadline", async () => {
		vi.useFakeTimers();
		try {
			expect(TOOL_HOST_CALL_TIMEOUT_MS).toBe(61_000);
			const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
			const sent: string[] = [];
			const fake = {
				data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
				readyState: 1,
				sendText(text: string): ToolHostSendStatus {
					sent.push(text);
					return 1;
				},
				ping: () => {},
				terminate: () => {},
				close: () => {},
			} as never;
			const websocket = host.websocket;
			websocket.open?.(fake);
			websocket.message(fake, JSON.stringify(registration()));
			let settled = false;
			const pending = host.callTool("session-a", "read", {});
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			vi.advanceTimersByTime(60_000);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(TOOL_HOST_CALL_TIMEOUT_MS - 60_000);
			await expect(pending).rejects.toThrow(/timed out/);
			const callFrame = JSON.parse(sent[0] ?? "") as ToolHostFrame;
			const cancelFrame = JSON.parse(sent[1] ?? "") as ToolHostFrame;
			if (callFrame.type !== "call_tool") throw new Error(`Expected call_tool, got ${callFrame.type}`);
			expect(cancelFrame).toEqual({
				type: "cancel_tool",
				requestId: callFrame.requestId,
				sessionId: callFrame.sessionId,
			});
			host.close();
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps accepted cancellation tombstones live beyond the per-owner capacity", async () => {
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const makeSocket = (sessionId: string, hostId: string) => {
			const sent: string[] = [];
			let closed = false;
			let readyState = 1;
			const fake = {
				data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
				readyState,
				sendText(text: string): ToolHostSendStatus {
					sent.push(text);
					return 1;
				},
				ping: () => {},
				terminate: () => {},
				close: () => {
					closed = true;
					readyState = 2;
				},
			} as never;
			const websocket = host.websocket;
			websocket.open?.(fake);
			websocket.message(fake, JSON.stringify(registration(sessionId, hostId)));
			return { fake, websocket, sent, wasClosed: () => closed || readyState !== 1 };
		};
		const first = makeSocket("session-a", "host-a");
		const second = makeSocket("session-b", "host-b");
		const cancel = async (
			socket: { fake: never; websocket: typeof host.websocket; sent: string[] },
			sessionId: string,
		): Promise<string> => {
			const controller = new AbortController();
			const pending = host.callTool(sessionId, "read", {}, controller.signal);
			const call = JSON.parse(socket.sent.at(-1)!) as { type: string; requestId: string };
			expect(call.type).toBe("call_tool");
			controller.abort();
			await expect(pending).rejects.toThrow(/aborted/);
			expect(JSON.parse(socket.sent.at(-1)!).type).toBe("cancel_tool");
			return call.requestId;
		};
		const secondRequestId = await cancel(second, "session-b");
		const firstRequestIds: string[] = [];
		for (let index = 0; index < 256; index += 1) firstRequestIds.push(await cancel(first, "session-a"));
		await expect(host.callTool("session-a", "read", {})).rejects.toThrow(/capacity|cancellation/i);
		first.websocket.message(
			first.fake,
			JSON.stringify({ type: "tool_result", requestId: firstRequestIds[0], result: { content: [] } }),
		);
		expect(first.wasClosed()).toBe(false);
		second.websocket.message(
			second.fake,
			JSON.stringify({ type: "tool_result", requestId: secondRequestId, result: { content: [] } }),
		);
		expect(second.wasClosed()).toBe(false);
		host.close();
	});
	it("does not create a cancellation tombstone for an unaccepted queued call", async () => {
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const data: ToolHostOutboundState = { queue: [], queuedBytes: 0, backpressured: false };
		const sent: string[] = [];
		let closed = false;
		const fake = {
			data,
			readyState: 1,
			sendText(text: string): ToolHostSendStatus {
				sent.push(text);
				return sent.length === 1 ? -1 : 1;
			},
			ping: () => {},
			terminate: () => {},
			close: () => {
				closed = true;
			},
		} as never;
		const websocket = host.websocket;
		websocket.open?.(fake);
		websocket.message(fake, JSON.stringify(registration()));
		const first = host.callTool("session-a", "read", {});
		const firstRequestId = JSON.parse(sent[0]!).requestId as string;
		websocket.message(
			fake,
			JSON.stringify({ type: "tool_result", requestId: firstRequestId, result: { content: [] } }),
		);
		await first;
		const controller = new AbortController();
		const second = host.callTool("session-a", "read", {}, controller.signal);
		const secondRequestId = data.queue[0]!.requestId!;
		controller.abort();
		await expect(second).rejects.toThrow(/aborted/);
		websocket.message(
			fake,
			JSON.stringify({ type: "tool_result", requestId: secondRequestId, result: { content: [] } }),
		);
		expect(closed).toBe(true);
		host.close();
	});
	it("clears owner tombstones on disconnect and server close", async () => {
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const sent: string[] = [];
		let closed = false;
		const fake = {
			data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
			readyState: 1,
			sendText(text: string): ToolHostSendStatus {
				sent.push(text);
				return 1;
			},
			ping: () => {},
			terminate: () => {},
			close: () => {
				closed = true;
			},
		} as never;
		const websocket = host.websocket;
		websocket.open?.(fake);
		websocket.message(fake, JSON.stringify(registration()));
		const controller = new AbortController();
		const pending = host.callTool("session-a", "read", {}, controller.signal);
		const requestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		websocket.close?.(fake, 1000, "disconnect");
		websocket.message(fake, JSON.stringify({ type: "tool_result", requestId, result: { content: [] } }));
		expect(closed).toBe(true);
		host.close();
	});
	it("clears all cancellation tombstones when the server closes", async () => {
		const host = new ToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		const sent: string[] = [];
		let closed = false;
		const fake = {
			data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
			readyState: 1,
			sendText(text: string): ToolHostSendStatus {
				sent.push(text);
				return 1;
			},
			ping: () => {},
			terminate: () => {},
			close: () => {
				closed = true;
			},
		} as never;
		const websocket = host.websocket;
		websocket.open?.(fake);
		websocket.message(fake, JSON.stringify(registration()));
		const controller = new AbortController();
		const pending = host.callTool("session-a", "read", {}, controller.signal);
		const requestId = (JSON.parse(sent[0]!) as { requestId: string }).requestId;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/);
		host.close();
		websocket.message(fake, JSON.stringify({ type: "tool_result", requestId, result: { content: [] } }));
		expect(closed).toBe(true);
	});
	it("expires a host that withholds pong only after heartbeat timeout", async () => {
		const socket: ToolHostHeartbeatSocket = { awaitingPong: false, closed: false, readyState: 1 };
		let pings = 0;
		let terminated = false;
		heartbeatToolHostSocket(
			socket,
			25,
			() => {
				pings += 1;
			},
			() => {
				terminated = true;
				socket.readyState = 2;
			},
		);
		heartbeatToolHostSocket(
			socket,
			25,
			() => {
				pings += 1;
			},
			() => {
				terminated = true;
				socket.readyState = 2;
			},
		);
		expect(pings).toBe(1);
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(terminated).toBe(false);
		await new Promise(resolve => setTimeout(resolve, 25));
		expect(terminated).toBe(true);
	});
	it("unregister rejects pending calls, removes the owner, and keeps the socket open", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		const pending = server.toolHost.callTool("session-a", "read", {});
		await nextMessage(ws);
		ws.send(JSON.stringify({ type: "unregister", sessionId: "session-a" }));
		await expect(pending).rejects.toThrow(/disconnect/);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(server.toolHost.registry.hasSession("session-a")).toBe(false);
		expect(
			server.toolHost.audit().some(entry => entry.action === "disconnect" && entry.sessionId === "session-a"),
		).toBe(true);
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});

	it("transitions from an old session to a new session on the same authenticated socket", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration("session-a", "host-a")));
		await new Promise(resolve => setTimeout(resolve, 20));

		const oldPending = server.toolHost.callTool("session-a", "read", {});
		const oldCall = await nextMessage(ws);
		expect(oldCall).toMatchObject({ type: "call_tool", sessionId: "session-a" });
		ws.send(JSON.stringify({ type: "unregister", sessionId: "session-a" }));
		await expect(oldPending).rejects.toThrow(/disconnect/);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(server.toolHost.registry.hasSession("session-a")).toBe(false);
		expect(ws.readyState).toBe(WebSocket.OPEN);

		ws.send(JSON.stringify(registration("session-b", "host-b")));
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(server.toolHost.registry.hasSession("session-a")).toBe(false);
		expect(server.toolHost.registry.hasSession("session-b")).toBe(true);

		const newPending = server.toolHost.callTool("session-b", "read", {});
		const newCall = await nextMessage(ws);
		expect(newCall).toMatchObject({ type: "call_tool", sessionId: "session-b" });
		if (newCall.type !== "call_tool") throw new Error("expected call frame");
		ws.send(JSON.stringify({ type: "tool_result", requestId: newCall.requestId, result: { content: [] } }));
		await expect(newPending).resolves.toEqual({ content: [] });
		await closeSocket(ws);
	});
	it("does not send a call for an already aborted signal", async () => {
		const server = await createServer();
		const ws = await connect(server);
		ws.send(JSON.stringify(registration()));
		await new Promise(resolve => setTimeout(resolve, 20));
		const controller = new AbortController();
		controller.abort();
		await expect(server.toolHost.callTool("session-a", "read", {}, controller.signal)).rejects.toThrow(/aborted/);
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(ws.readyState).toBe(WebSocket.OPEN);
	});
	it("cleans up provisioning failure on a fixed port for immediate reuse", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-provision-fail-"));
		temporaryDirectories.push(stateDir);
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
		const port = probe.port;
		await probe.stop(true);
		const config = resolveBridgeConfig({ stateDir, primeConfigFile: path.join(stateDir, "omp-bridge.json"), port });
		let closed = false;
		class TrackingToolHostServer extends ToolHostServer {
			override close(): void {
				closed = true;
				super.close();
			}
		}
		const toolHost = new TrackingToolHostServer({ heartbeatIntervalMs: 1_000_000 });
		await expect(
			startPrimeBridgeServer({ config, primeConfigFile: stateDir, toolHost, peers: () => [] }),
		).rejects.toThrow();
		expect(closed).toBe(true);
		const recovered = await startPrimeBridgeServer({ config, peers: () => [] });
		expect(new URL(recovered.url).port).toBe(String(port));
		await recovered.stop();
	});
	it("does not drain a timed-out queued call or its cancellation", async () => {
		vi.useFakeTimers();
		try {
			const host = new ToolHostServer({ callTimeoutMs: 10, heartbeatIntervalMs: 1_000_000 });
			const sent: string[] = [];
			const statuses: ToolHostSendStatus[] = [-1, 1, 1];
			const fake = {
				data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
				readyState: 1,
				sendText(text: string): ToolHostSendStatus {
					sent.push(text);
					return statuses.shift() ?? 1;
				},
				ping(): void {},
				terminate(): void {},
				close(): void {},
			} as never;
			const websocket = host.websocket;
			websocket.open?.(fake);
			websocket.message(fake, JSON.stringify(registration()));
			const first = host.callTool("session-a", "read", {});
			const firstRequestId = JSON.parse(sent[0]!).requestId as string;
			websocket.message(
				fake,
				JSON.stringify({ type: "tool_result", requestId: firstRequestId, result: { content: [] } }),
			);
			await first;
			const second = host.callTool("session-a", "read", {});
			vi.advanceTimersByTime(10);
			await Promise.resolve();
			await expect(second).rejects.toThrow(/timed out/);
			websocket.drain?.(fake);
			expect(sent.map(text => JSON.parse(text).type)).toEqual(["call_tool"]);
			host.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not drain an aborted queued call or its cancellation", async () => {
		const host = new ToolHostServer({ callTimeoutMs: 1_000, heartbeatIntervalMs: 1_000_000 });
		const sent: string[] = [];
		const statuses: ToolHostSendStatus[] = [-1, 1, 1];
		const fake = {
			data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
			readyState: 1,
			sendText(text: string): ToolHostSendStatus {
				sent.push(text);
				return statuses.shift() ?? 1;
			},
			ping(): void {},
			terminate(): void {},
			close(): void {},
		} as never;
		const websocket = host.websocket;
		websocket.open?.(fake);
		websocket.message(fake, JSON.stringify(registration()));
		const first = host.callTool("session-a", "read", {});
		const controller = new AbortController();
		const second = host.callTool("session-a", "read", {}, controller.signal);
		controller.abort();
		await expect(second).rejects.toThrow(/aborted/);
		websocket.drain?.(fake);
		expect(sent.map(text => JSON.parse(text).type)).toEqual(["call_tool"]);
		websocket.message(
			fake,
			JSON.stringify({ type: "tool_result", requestId: JSON.parse(sent[0]!).requestId, result: { content: [] } }),
		);
		await first;
		host.close();
	});

	it("closes the tool host when fixed-port startup fails and can reuse the port", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-bind-conflict-"));
		temporaryDirectories.push(stateDir);
		const competing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("competing") });
		try {
			const config = resolveBridgeConfig({
				stateDir,
				primeConfigFile: path.join(stateDir, "omp-bridge.json"),
				port: competing.port,
			});
			let closed = false;
			class TrackingToolHostServer extends ToolHostServer {
				override close(): void {
					closed = true;
					super.close();
				}
			}
			const failedToolHost = new TrackingToolHostServer({ heartbeatIntervalMs: 1_000_000 });
			await expect(startPrimeBridgeServer({ config, peers: () => [], toolHost: failedToolHost })).rejects.toThrow();
			expect(closed).toBe(true);
		} finally {
			await competing.stop(true);
		}
		const config = resolveBridgeConfig({
			stateDir,
			primeConfigFile: path.join(stateDir, "omp-bridge.json"),
			port: competing.port,
		});
		const recovered = await startPrimeBridgeServer({ config, peers: () => [] });
		await recovered.stop();
	});
});

describe("tool host session id collisions", () => {
	/** A minimal live host socket, matching the fake used elsewhere in this file. */
	function fakeSocket(): { socket: never; closes: { code: number; reason: string }[] } {
		const closes: { code: number; reason: string }[] = [];
		const socket = {
			data: { awaitingPong: false, closed: false, queue: [], queuedBytes: 0, backpressured: false },
			readyState: 1,
			sendText: () => 1,
			ping: () => {},
			terminate: () => {},
			close: (code: number, reason: string) => {
				closes.push({ code, reason });
			},
		} as never;
		return { socket, closes };
	}

	function register(host: ToolHostServer, socket: never, sessionId: string, hostId: string): void {
		host.websocket.open?.(socket);
		host.websocket.message(socket, JSON.stringify(registration(sessionId, hostId)));
	}

	it("records which host displaced which when two hosts share a session id", () => {
		const host = new ToolHostServer();
		const first = fakeSocket();
		const second = fakeSocket();

		register(host, first.socket, "shared-session", "host-a");
		register(host, second.socket, "shared-session", "host-b");

		// Takeover itself is intentional: a restarted host must be able to reclaim its
		// session id, and pending calls fail with a disconnect rather than hanging. What
		// was missing is any record that the executor changed — after this the caller's
		// tools run in host-b's context, and host-a never reconnects.
		const replaced = host.audit().filter(entry => entry.action === "register_replaced");
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatchObject({
			sessionId: "shared-session",
			hostId: "host-b",
			previousHostId: "host-a",
		});
		expect(first.closes).toEqual([{ code: 4009, reason: "replaced by reconnect" }]);
		expect(host.registry.getOwner("shared-session")?.hostId).toBe("host-b");
	});

	it("stays quiet when the same host re-registers its own session id", () => {
		const host = new ToolHostServer();
		const first = fakeSocket();
		const second = fakeSocket();

		register(host, first.socket, "shared-session", "host-a");
		register(host, second.socket, "shared-session", "host-a");

		// A genuine reconnect is not a collision and must not look like one.
		expect(host.audit().filter(entry => entry.action === "register_replaced")).toHaveLength(0);
		expect(host.registry.getOwner("shared-session")?.hostId).toBe("host-a");
	});

	it("stays quiet when the displaced socket is already dead", () => {
		const host = new ToolHostServer();
		const dead = fakeSocket();
		const restarted = fakeSocket();

		register(host, dead.socket, "shared-session", "host-old");
		// A restarted process gets a fresh host id, so a dead incumbent plus a new id is
		// an ordinary restart, not two live sessions fighting over one id.
		(dead.socket as unknown as { readyState: number }).readyState = 3;
		register(host, restarted.socket, "shared-session", "host-new");

		expect(host.audit().filter(entry => entry.action === "register_replaced")).toHaveLength(0);
		expect(host.registry.getOwner("shared-session")?.hostId).toBe("host-new");
	});

	it("leaves unrelated session ids alone", () => {
		const host = new ToolHostServer();
		const first = fakeSocket();
		const second = fakeSocket();

		register(host, first.socket, "session-a", "host-a");
		register(host, second.socket, "session-b", "host-b");

		expect(host.audit().filter(entry => entry.action === "register_replaced")).toHaveLength(0);
		expect(second.closes).toEqual([]);
		expect(host.registry.getOwner("session-a")?.hostId).toBe("host-a");
		expect(host.registry.getOwner("session-b")?.hostId).toBe("host-b");
	});
});
