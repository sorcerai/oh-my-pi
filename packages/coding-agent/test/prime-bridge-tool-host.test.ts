import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	PrimeBridgeHostAdapter,
	type PrimeBridgeHostSession,
	type PrimeBridgeHostWebSocket,
} from "../src/integrations/prime-bridge/tool-host-adapter";

const argsSchema = type({ value: "string" });

type SentFrame = Record<string, unknown>;

class FakeWebSocket implements PrimeBridgeHostWebSocket {
	readonly sent: SentFrame[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(frame: SentFrame): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as SentFrame);
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	fail(): void {
		this.onerror?.();
	}
}

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: argsSchema,
		execute,
	};
}

function session(
	sessionId: string,
	tools: Map<string, AgentTool>,
	enabledNames: string[] = [...tools.keys()],
	context: AgentToolContext = {} as unknown as AgentToolContext,
): PrimeBridgeHostSession & { setEnabled(names: string[]): void; setSessionId(id: string): void } {
	let currentSessionId = sessionId;
	let enabled = enabledNames;
	const changeCallbacks = new Set<() => void>();
	return {
		agentSession: {
			getEnabledToolNames: () => enabled,
		},
		toolSession: {
			getSessionId: () => currentSessionId,
			getToolByName: name => tools.get(name),
			registerSessionChangeCallback: callback => {
				changeCallbacks.add(callback);
				return () => changeCallbacks.delete(callback);
			},
		},
		getToolContext: () => context,
		setEnabled(names) {
			enabled = names;
			for (const callback of changeCallbacks) callback();
		},
		setSessionId(id) {
			currentSessionId = id;
			for (const callback of changeCallbacks) callback();
		},
	};
}

async function started(
	value: PrimeBridgeHostSession,
	config: Partial<Parameters<PrimeBridgeHostAdapter["start"]>[1]> = {},
): Promise<{ adapter: PrimeBridgeHostAdapter; socket: FakeWebSocket }> {
	const socket = new FakeWebSocket();
	const adapter = new PrimeBridgeHostAdapter({
		websocketFactory: () => socket,
	});
	const start = adapter.start(value, {
		enabled: true,
		url: "http://127.0.0.1:8787",
		tokenPath: "token",
		readFile: async () => "test-token",
		...config,
	});
	while (socket.onopen === null) await Promise.resolve();
	socket.open();
	await start;
	return { adapter, socket };
}

describe("PrimeBridgeHostAdapter", () => {
	it("rejects non-loopback, credentialed, and non-root bridge URLs before reading the token", async () => {
		for (const url of [
			"http://example.com",
			"http://2130706433:8787",
			"http://127.1:8787",
			"https://127.0.0.1:8787",
			"ws://127.0.0.1:8787",
			"http://user:pass@127.0.0.1:8787",
			"http://:@127.0.0.1:8787",
			"http://127.0.0.1:8787/path",
			"http://127.0.0.1:8787/.",
			"http://127.0.0.1:8787?token=secret",
			"http://127.0.0.1:8787#token",
		]) {
			const socket = new FakeWebSocket();
			const readFile = vi.fn(async () => "test-token");
			const websocketFactory = vi.fn(() => socket);
			const adapter = new PrimeBridgeHostAdapter({ websocketFactory });
			await expect(
				adapter.start(session("session-a", new Map()), {
					enabled: true,
					url,
					tokenPath: "token",
					readFile,
				}),
			).rejects.toThrow("plain loopback HTTP");
			expect(readFile).not.toHaveBeenCalled();
			expect(websocketFactory).not.toHaveBeenCalled();
		}
	});

	it("rejects invalid approval timeouts before reading the token or opening a socket", async () => {
		for (const approvalTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
			const readFile = vi.fn(async () => "test-token");
			const websocketFactory = vi.fn(() => new FakeWebSocket());
			const adapter = new PrimeBridgeHostAdapter({ websocketFactory });
			await expect(
				adapter.start(session("session-a", new Map()), {
					enabled: true,
					url: "http://127.0.0.1:8787",
					tokenPath: "token",
					approvalTimeoutMs,
					readFile,
				}),
			).rejects.toThrow("Prime bridge approvalTimeoutMs must be between 1 and 60000 milliseconds");
			expect(readFile).not.toHaveBeenCalled();
			expect(websocketFactory).not.toHaveBeenCalled();
		}
	});

	it("accepts the inclusive approval timeout boundaries", async () => {
		for (const approvalTimeoutMs of [1, 60_000]) {
			const value = session("session-a", new Map());
			const { adapter } = await started(value, { approvalTimeoutMs });
			await adapter.stop();
		}
	});

	it("accepts a plain localhost HTTP root URL and converts it to the tool-host websocket path", async () => {
		const socket = new FakeWebSocket();
		const readFile = vi.fn(async () => "test-token");
		const websocketFactory = vi.fn(() => socket);
		const adapter = new PrimeBridgeHostAdapter({ websocketFactory });
		const start = adapter.start(session("session-a", new Map()), {
			enabled: true,
			url: "http://localhost:8787/",
			tokenPath: "token",
			readFile,
		});
		while (socket.onopen === null) await Promise.resolve();
		socket.open();
		await start;
		expect(readFile).toHaveBeenCalledWith("token", "utf8");
		expect(websocketFactory).toHaveBeenCalledWith("ws://localhost:8787/v1/tool-host", "test-token");
		await adapter.stop();
	});

	it("registers the active session and JSON schemas", async () => {
		const value = session("session-a", new Map([["read", tool("read", async () => ({ content: [] }))]]));
		const { adapter, socket } = await started(value);

		expect(socket.sent).toContainEqual({
			type: "register",
			hostId: expect.any(String),
			sessionId: "session-a",
			tools: [
				{
					name: "read",
					description: "read description",
					inputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
						$schema: "http://json-schema.org/draft-07/schema#",
					},
				},
			],
		});
		await adapter.stop();
	});

	it("omits disabled and restricted tools unless explicitly allowed", async () => {
		const value = session(
			"session-a",
			new Map([
				["echo", tool("echo", async () => ({ content: [] }))],
				["bash", tool("bash", async () => ({ content: [] }))],
				["write", tool("write", async () => ({ content: [] }))],
			]),
			["echo", "bash", "write", "disabled"],
		);
		const { adapter, socket } = await started(value, { allowTools: ["write"] });

		const registeredTools = socket.sent[0]?.tools;
		expect(Array.isArray(registeredTools) ? registeredTools.map(tool => tool.name) : undefined).toEqual(["write"]);
		await adapter.stop();
	});

	it("emits tools_changed when the active inventory changes", async () => {
		const value = session("session-a", new Map([["read", tool("read", async () => ({ content: [] }))]]));
		const { adapter, socket } = await started(value);

		value.setEnabled([]);
		await Promise.resolve();
		expect(socket.sent.at(-1)).toEqual({ type: "tools_changed", sessionId: "session-a", tools: [] });
		await adapter.stop();
	});

	it("keeps same-name tools isolated across sessions", async () => {
		const first = await started(session("first", new Map([["read", tool("read", async () => ({ content: [] }))]])));
		const second = await started(session("second", new Map([["read", tool("read", async () => ({ content: [] }))]])));

		expect(first.socket.sent[0]).toMatchObject({ sessionId: "first" });
		expect(second.socket.sent[0]).toMatchObject({ sessionId: "second" });
		await first.adapter.stop();
		await second.adapter.stop();
	});

	it("executes the wrapped tool with an opaque call id, signal, update callback, and context", async () => {
		let observed:
			| {
					id: string;
					args: unknown;
					signal?: AbortSignal;
					onUpdate?: (result: AgentToolResult) => void;
					context?: AgentToolContext;
			  }
			| undefined;
		const context = { marker: "session-context" } as unknown as AgentToolContext;
		const value = session(
			"session-a",
			new Map([
				[
					"echo",
					tool("echo", async (id, args, signal, onUpdate, toolContext) => {
						observed = { id, args, signal, onUpdate, context: toolContext };
						return { content: [{ type: "text", text: "ok" }] };
					}),
				],
			]),
			["echo"],
			context,
		);
		const { adapter, socket } = await started(value, { allowTools: ["echo"] });

		socket.receive({
			type: "call_tool",
			requestId: "prime-request",
			sessionId: "session-a",
			toolName: "echo",
			arguments: { value: "x" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(observed?.id).toMatch(/^prime-bridge:/);
		expect(observed?.id).not.toBe("prime-request");
		expect(observed?.args).toEqual({ value: "x" });
		expect(observed?.signal).toBeInstanceOf(AbortSignal);
		expect(observed?.onUpdate).toEqual(expect.any(Function));
		expect(observed?.context).toBe(context);
		expect(socket.sent.at(-1)).toEqual({
			type: "tool_result",
			requestId: "prime-request",
			result: { content: [{ type: "text", text: "ok" }] },
		});
		await adapter.stop();
	});

	it("aborts and reports denial, timeout, cancellation, and disconnect safely", async () => {
		let aborts = 0;
		const pending = Promise.withResolvers<void>();
		const value = session(
			"session-a",
			new Map([
				[
					"deny",
					tool("deny", async () => {
						throw new Error("approval denied");
					}),
				],
				[
					"slow",
					tool("slow", async (_id, _args, signal) => {
						if (signal === undefined) throw new Error("missing execution signal");
						signal.addEventListener(
							"abort",
							() => {
								aborts += 1;
								pending.resolve();
							},
							{ once: true },
						);
						await pending.promise;
						throw new Error("aborted");
					}),
				],
			]),
		);
		const { adapter, socket } = await started(value, {
			allowTools: ["deny", "slow", "cancel"],
			approvalTimeoutMs: 5,
		});

		socket.receive({
			type: "call_tool",
			requestId: "deny-request",
			sessionId: "session-a",
			toolName: "deny",
			arguments: { value: "x" },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(socket.sent.at(-1)).toMatchObject({ type: "tool_error", requestId: "deny-request" });

		socket.receive({
			type: "call_tool",
			requestId: "timeout-request",
			sessionId: "session-a",
			toolName: "slow",
			arguments: { value: "x" },
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(aborts).toBe(1);
		expect(socket.sent.at(-1)).toMatchObject({ type: "tool_error", requestId: "timeout-request" });
		const cancelPending = Promise.withResolvers<void>();

		const cancelTool = tool("cancel", async (_id, _args, signal) => {
			if (signal === undefined) throw new Error("missing execution signal");
			signal.addEventListener("abort", () => cancelPending.resolve(), { once: true });
			await cancelPending.promise;
			throw new Error("canceled");
		});
		value.toolSession.getToolByName = name => (name === "cancel" ? cancelTool : undefined);
		value.setEnabled(["cancel"]);
		socket.receive({
			type: "call_tool",
			requestId: "cancel-request",
			sessionId: "session-a",
			toolName: "cancel",
			arguments: { value: "x" },
		});
		socket.receive({ type: "cancel_tool", requestId: "cancel-request", sessionId: "session-a" });
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(socket.sent.at(-1)).toMatchObject({ type: "tool_error", requestId: "cancel-request" });

		socket.receive({
			type: "call_tool",
			requestId: "disconnect-request",
			sessionId: "session-a",
			toolName: "cancel",
			arguments: { value: "x" },
		});
		socket.close();
		await adapter.stop();
	});

	it("uses fixed errors and settles terminal cancellation before ignored executions return", async () => {
		vi.useFakeTimers();
		const ignored = Promise.withResolvers<AgentToolResult>();
		const executionStarts = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		];
		let executionIndex = 0;
		let adapter: PrimeBridgeHostAdapter | undefined;
		let socket: FakeWebSocket | undefined;
		try {
			const value = session(
				"session-a",
				new Map([
					[
						"slow",
						tool("slow", async () => {
							executionStarts[executionIndex]?.resolve();
							executionIndex += 1;
							return await ignored.promise;
						}),
					],
				]),
			);
			const startedValue = await started(value, { allowTools: ["slow"], approvalTimeoutMs: 5 });
			adapter = startedValue.adapter;
			socket = startedValue.socket;
			socket.receive({
				type: "call_tool",
				requestId: "timeout-request",
				sessionId: "session-a",
				toolName: "slow",
				arguments: { value: "x" },
			});
			await executionStarts[0]?.promise;
			vi.advanceTimersByTime(5);
			expect(socket.sent.at(-1)).toMatchObject({
				type: "tool_error",
				requestId: "timeout-request",
				code: "approval_timeout",
			});
			socket.receive({
				type: "call_tool",
				requestId: "cancel-request",
				sessionId: "session-a",
				toolName: "slow",
				arguments: { value: "x" },
			});
			await executionStarts[1]?.promise;
			socket.receive({ type: "cancel_tool", requestId: "cancel-request", sessionId: "session-a" });
			expect(socket.sent.at(-1)).toMatchObject({
				type: "tool_error",
				requestId: "cancel-request",
				code: "tool_canceled",
			});
			socket.receive({
				type: "call_tool",
				requestId: "stop-request",
				sessionId: "session-a",
				toolName: "slow",
				arguments: { value: "x" },
			});
			await executionStarts[2]?.promise;
			await adapter.stop();
			expect(socket.sent.at(-2)).toMatchObject({
				type: "tool_error",
				requestId: "stop-request",
				code: "tool_host_stopped",
			});
		} finally {
			ignored.resolve({ content: [] });
			await adapter?.stop();
			vi.useRealTimers();
		}
	});
	it("settles pending calls before replacing the session registration", async () => {
		const lateResult = Promise.withResolvers<AgentToolResult>();
		const executionStarted = Promise.withResolvers<void>();
		let executionCount = 0;
		let oldControllerAborted = false;
		const value = session(
			"session-a",
			new Map([
				[
					"slow",
					tool("slow", async (_id, _args, signal) => {
						if (signal === undefined) throw new Error("missing execution signal");
						signal.addEventListener("abort", () => {
							oldControllerAborted = true;
						});
						executionCount += 1;
						if (executionCount === 1) {
							executionStarted.resolve();
							return await lateResult.promise;
						}
						return { content: [{ type: "text", text: "session-b result" }] };
					}),
				],
			]),
		);
		const { adapter, socket } = await started(value, { allowTools: ["slow"] });
		try {
			socket.receive({
				type: "call_tool",
				requestId: "session-a-request",
				sessionId: "session-a",
				toolName: "slow",
				arguments: { value: "x" },
			});
			await executionStarted.promise;
			const transitionStart = socket.sent.length;

			value.setSessionId("session-b");
			expect(oldControllerAborted).toBe(true);

			const transitionFrames = socket.sent.slice(transitionStart);
			expect(transitionFrames).toHaveLength(3);
			expect(transitionFrames[0]).toEqual({
				type: "tool_error",
				requestId: "session-a-request",
				code: "tool_host_stopped",
				message: "Tool host stopped.",
			});
			expect(transitionFrames[1]).toEqual({ type: "unregister", sessionId: "session-a" });
			expect(transitionFrames[2]).toMatchObject({
				type: "register",
				hostId: expect.any(String),
				sessionId: "session-b",
			});

			lateResult.resolve({ content: [{ type: "text", text: "late session-a result" }] });
			await Promise.resolve();
			expect(
				socket.sent.some(frame => frame.requestId === "session-a-request" && frame.type === "tool_result"),
			).toBe(false);

			const framesBeforeLateCall = socket.sent.length;
			socket.receive({
				type: "call_tool",
				requestId: "late-session-a-request",
				sessionId: "session-a",
				toolName: "slow",
				arguments: {},
			});
			await Promise.resolve();
			expect(socket.sent).toHaveLength(framesBeforeLateCall);

			socket.receive({
				type: "call_tool",
				requestId: "session-b-request",
				sessionId: "session-b",
				toolName: "slow",
				arguments: { value: "y" },
			});
			await Promise.resolve();
			expect(socket.sent.at(-1)).toEqual({
				type: "tool_result",
				requestId: "session-b-request",
				result: { content: [{ type: "text", text: "session-b result" }] },
			});
		} finally {
			lateResult.resolve({ content: [] });
			await adapter.stop();
		}
	});

	it("uses the 60 second approval timeout by default", async () => {
		// The adapter must match the user-facing settings default.
		vi.useFakeTimers();
		const pending = Promise.withResolvers<AgentToolResult>();
		let adapter: PrimeBridgeHostAdapter | undefined;
		try {
			const value = session("session-a", new Map([["read", tool("read", async () => await pending.promise)]]));
			const startedValue = await started(value);
			adapter = startedValue.adapter;
			startedValue.socket.receive({
				type: "call_tool",
				requestId: "default-timeout",
				sessionId: "session-a",
				toolName: "read",
				arguments: { value: "x" },
			});
			await Promise.resolve();
			vi.advanceTimersByTime(59_999);
			expect(
				startedValue.socket.sent.some(
					frame => frame.requestId === "default-timeout" && frame.type === "tool_error",
				),
			).toBe(false);
			vi.advanceTimersByTime(1);
			expect(startedValue.socket.sent.at(-1)).toMatchObject({
				type: "tool_error",
				requestId: "default-timeout",
				code: "approval_timeout",
			});
		} finally {
			pending.resolve({ content: [] });
			await adapter?.stop();
			vi.useRealTimers();
		}
	});

	it("ignores callbacks from a replaced WebSocket", async () => {
		const sockets = [new FakeWebSocket(), new FakeWebSocket()];
		const adapter = new PrimeBridgeHostAdapter({ websocketFactory: () => sockets.shift() as FakeWebSocket });
		let firstExecutions = 0;
		let secondExecutions = 0;
		const first = session(
			"first",
			new Map([
				[
					"read",
					tool("read", async () => {
						firstExecutions += 1;
						return { content: [] };
					}),
				],
			]),
		);
		const second = session(
			"second",
			new Map([
				[
					"read",
					tool("read", async () => {
						secondExecutions += 1;
						return { content: [] };
					}),
				],
			]),
		);
		const config = {
			enabled: true,
			url: "http://127.0.0.1:8787",
			tokenPath: "token",
			readFile: async () => "test-token",
		};
		const firstSocket = sockets[0] as FakeWebSocket;
		const firstStart = adapter.start(first, config);
		while (firstSocket.onopen === null) await Promise.resolve();
		firstSocket.open();
		await firstStart;
		const secondSocket = sockets[0] as FakeWebSocket;
		const secondStart = adapter.start(second, config);
		while (secondSocket.onopen === null) await Promise.resolve();
		secondSocket.open();
		await secondStart;

		firstSocket.receive({
			type: "call_tool",
			requestId: "stale",
			sessionId: "first",
			toolName: "read",
			arguments: { value: "x" },
		});
		firstSocket.open();
		firstSocket.close();
		firstSocket.fail();
		secondSocket.receive({
			type: "call_tool",
			requestId: "current",
			sessionId: "second",
			toolName: "read",
			arguments: { value: "x" },
		});
		await Bun.sleep(0);

		expect(firstExecutions).toBe(0);
		expect(secondExecutions).toBe(1);
		expect(secondSocket.sent.at(-1)).toMatchObject({ type: "tool_result", requestId: "current" });
		await adapter.stop();
	});

	it("does not expose thrown secret text in fixed execution errors", async () => {
		const value = session(
			"session-a",
			new Map([
				[
					"secret",
					tool("secret", async () => {
						throw Object.assign(new Error("super-secret-token"), { code: "approval_denied" });
					}),
				],
			]),
		);
		const { adapter, socket } = await started(value, { allowTools: ["secret"] });
		socket.receive({
			type: "call_tool",
			requestId: "secret-request",
			sessionId: "session-a",
			toolName: "secret",
			arguments: { value: "x" },
		});
		await Promise.resolve();
		expect(socket.sent.at(-1)).toEqual({
			type: "tool_error",
			requestId: "secret-request",
			code: "approval_denied",
			message: "Tool execution denied.",
		});
		await adapter.stop();
	});

	it("closes and unsubscribes when the WebSocket fails before opening", async () => {
		const socket = new FakeWebSocket();
		const adapter = new PrimeBridgeHostAdapter({ websocketFactory: () => socket });
		const value = session("session-a", new Map([["echo", tool("echo", async () => ({ content: [] }))]]));
		const start = adapter.start(value, {
			enabled: true,
			url: "http://127.0.0.1:8787",
			tokenPath: "token",
			readFile: async () => "test-token",
		});
		while (socket.onerror === null) await Promise.resolve();
		socket.fail();
		await expect(start).rejects.toThrow("connection failed");
		expect(socket.readyState).toBe(3);
		const frameCount = socket.sent.length;
		value.setEnabled([]);
		expect(socket.sent.length).toBe(frameCount);
	});
});
