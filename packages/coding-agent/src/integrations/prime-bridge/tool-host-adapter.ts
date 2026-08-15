import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { parseToolHostFrame, type RegisteredTool, type ToolHostFrame } from "@oh-my-pi/prime-bridge-protocol";
import {
	PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS,
	validatePrimeBridgeApprovalTimeoutMs,
} from "../../config/settings-schema";
import type { ToolSession } from "../../tools";

const DEFAULT_APPROVAL_TIMEOUT_MS = PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS;
const DEFAULT_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "web_search"]);

type ReadFile = (path: string, encoding: "utf8") => Promise<string>;
export type PrimeBridgeHostWebSocketFactory = (url: string, token: string) => PrimeBridgeHostWebSocket;

export interface PrimeBridgeHostWebSocket {
	readonly readyState: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	send(data: string): void;
	close(): void;
}

export interface PrimeBridgeHostSession {
	readonly agentSession: {
		getEnabledToolNames(): string[];
	};
	readonly toolSession: Pick<ToolSession, "getSessionId" | "getToolByName" | "registerSessionChangeCallback">;
	readonly getToolContext: () => AgentToolContext | undefined;
}

export interface PrimeBridgeHostAdapterConfig {
	readonly enabled: boolean;
	readonly url?: string;
	readonly tokenPath?: string;
	readonly allowTools?: readonly string[];
	/**
	 * Register under this session id instead of the session's generated one.
	 *
	 * A consumer holding a pre-minted, session-scoped grant cannot match an id
	 * that changes every run. Setting a stable id lets the grant be issued once.
	 * The bridge keys tool registration by session, so two live sessions sharing
	 * one id would publish over each other — give each its own.
	 */
	readonly sessionId?: string;
	readonly approvalTimeoutMs?: number;
	readonly readFile?: ReadFile;
	readonly websocketFactory?: PrimeBridgeHostWebSocketFactory;
}

interface PendingCall {
	readonly requestId: string;
	readonly controller: AbortController;
	readonly timer: ReturnType<typeof setTimeout>;
	reason?: "approval_timeout" | "tool_canceled" | "tool_host_stopped" | "disconnected";
}

function websocketUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Prime bridge url must be plain loopback HTTP");
	}
	const authorityMatch = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/i.exec(value);
	const authority = authorityMatch?.[1];
	const rawPath = authorityMatch?.[2] ?? "";
	const isPlainLoopbackAuthority = authority !== undefined && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(authority);
	if (
		url.protocol !== "http:" ||
		!isPlainLoopbackAuthority ||
		authority?.includes("@") === true ||
		url.username !== "" ||
		url.password !== "" ||
		!["", "/"].includes(rawPath) ||
		!["", "/"].includes(url.pathname) ||
		url.search !== "" ||
		url.hash !== ""
	)
		throw new Error("Prime bridge url must be plain loopback HTTP");
	url.protocol = "ws:";
	url.pathname = "/v1/tool-host";
	return url.toString();
}

function errorCode(error: unknown): string {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	return code === "approval_denied" ? "approval_denied" : "tool_execution_failed";
}

function errorPublicMessage(code: string): string {
	return code === "approval_denied" ? "Tool execution denied." : "Tool execution failed.";
}

function toRegisteredTool(tool: AgentTool): RegisteredTool {
	const schema = tool.parameters as unknown as { toJsonSchema(options: { target: string }): Record<string, unknown> };
	const inputSchema = schema.toJsonSchema({ target: "draft-07" });
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema,
	};
}

export class PrimeBridgeHostAdapter {
	readonly #websocketFactory: PrimeBridgeHostWebSocketFactory;
	#socket: PrimeBridgeHostWebSocket | undefined;
	#session: PrimeBridgeHostSession | undefined;
	#config: PrimeBridgeHostAdapterConfig | undefined;
	#sessionId: string | undefined;
	#registeredTools: readonly RegisteredTool[] = [];
	#pending = new Map<string, PendingCall>();
	#unsubscribeSessionChange: (() => void) | undefined;
	#stopped = true;

	constructor(options: { websocketFactory?: PrimeBridgeHostWebSocketFactory } = {}) {
		this.#websocketFactory =
			options.websocketFactory ??
			((url, token): PrimeBridgeHostWebSocket => {
				const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
				return socket as unknown as PrimeBridgeHostWebSocket;
			});
	}

	async start(session: PrimeBridgeHostSession, config: PrimeBridgeHostAdapterConfig): Promise<void> {
		await this.stop();
		this.#session = session;
		this.#config = config;
		this.#stopped = false;
		if (!config.enabled) return;
		try {
			validatePrimeBridgeApprovalTimeoutMs(config.approvalTimeoutMs);
			if (config.url === undefined || config.tokenPath === undefined)
				throw new Error("Prime bridge tool host requires url and tokenPath");
			const hostUrl = websocketUrl(config.url);
			const readFile = config.readFile ?? (async (path, encoding) => await fs.readFile(path, encoding));
			const token = (await readFile(config.tokenPath, "utf8")).trim();
			if (token.length === 0) throw new Error("Prime bridge token is empty");
			const socket = this.#websocketFactory(hostUrl, token);
			this.#socket = socket;
			const opened = Promise.withResolvers<void>();
			socket.onopen = () => {
				if (this.#socket !== socket) return;
				opened.resolve();
				this.#sendRegister();
			};
			socket.onmessage = event => {
				if (this.#socket === socket) this.#receive(event.data);
			};
			socket.onerror = () => {
				if (this.#socket === socket) opened.reject(new Error("Prime bridge tool host connection failed"));
			};
			socket.onclose = () => {
				if (this.#socket !== socket) return;
				if (!this.#stopped) this.#abortPending("disconnected");
				opened.resolve();
			};
			const onSessionChange = session.toolSession.registerSessionChangeCallback;
			if (onSessionChange !== undefined) {
				const unsubscribe = onSessionChange(() => this.refreshTools());
				this.#unsubscribeSessionChange = typeof unsubscribe === "function" ? unsubscribe : undefined;
			}
			if (socket.readyState === 1) socket.onopen();
			await opened.promise;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	refreshTools(): void {
		const session = this.#session;
		if (this.#stopped || this.#socket?.readyState !== 1 || session === undefined) return;
		const nextSessionId = this.#publishedSessionId();
		if (nextSessionId === undefined) return;
		if (this.#sessionId !== undefined && this.#sessionId !== nextSessionId) {
			for (const requestId of this.#pending.keys())
				this.#settlePending(requestId, "tool_host_stopped", "Tool host stopped.");
			this.#send({ type: "unregister", sessionId: this.#sessionId });
			this.#sessionId = undefined;
			this.#registeredTools = [];
			this.#sendRegister();
			return;
		}
		const tools = this.#visibleTools();
		if (this.#sessionId === undefined) {
			this.#sessionId = nextSessionId;
			this.#registeredTools = tools;
			this.#send({ type: "register", hostId: this.#hostId, sessionId: nextSessionId, tools });
			return;
		}
		if (JSON.stringify(tools) === JSON.stringify(this.#registeredTools)) return;
		this.#registeredTools = tools;
		this.#send({ type: "tools_changed", sessionId: nextSessionId, tools });
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#unsubscribeSessionChange?.();
		this.#unsubscribeSessionChange = undefined;
		for (const requestId of this.#pending.keys()) {
			this.#settlePending(requestId, "tool_host_stopped", "Tool host stopped.");
		}
		if (this.#socket?.readyState === 1 && this.#sessionId !== undefined)
			this.#send({ type: "unregister", sessionId: this.#sessionId });
		this.#socket?.close();
		this.#socket = undefined;
		this.#sessionId = undefined;
		this.#registeredTools = [];
		this.#session = undefined;
		this.#config = undefined;
	}

	readonly #hostId = `omp-${randomUUID()}`;

	#visibleTools(): readonly RegisteredTool[] {
		const session = this.#session;
		const config = this.#config;
		const getToolByName = session?.toolSession.getToolByName;
		if (session === undefined || config === undefined || getToolByName === undefined) return [];
		const allowed = new Set([...DEFAULT_ALLOWED_TOOLS, ...(config.allowTools ?? [])]);
		const names = session.agentSession.getEnabledToolNames();
		const tools: RegisteredTool[] = [];
		const seen = new Set<string>();
		for (const name of names) {
			if (seen.has(name) || !allowed.has(name)) continue;
			const tool = getToolByName(name);
			if (tool === undefined) continue;
			seen.add(name);
			tools.push(toRegisteredTool(tool));
		}
		return tools;
	}

	/**
	 * The session id this host publishes under.
	 *
	 * A configured id wins over the generated one so a pre-minted, session-scoped
	 * grant keeps matching across runs. Returns undefined until the session exists,
	 * so nothing registers for a session that never started.
	 */
	#publishedSessionId(): string | undefined {
		const generated = this.#session?.toolSession.getSessionId?.() ?? undefined;
		if (generated === undefined) return undefined;
		return this.#config?.sessionId ?? generated;
	}

	#sendRegister(): void {
		const sessionId = this.#publishedSessionId();
		if (sessionId === undefined) return;
		this.#sessionId = sessionId;
		this.#registeredTools = this.#visibleTools();
		this.#send({ type: "register", hostId: this.#hostId, sessionId, tools: this.#registeredTools });
	}

	#send(frame: ToolHostFrame): void {
		if (this.#socket?.readyState !== 1) return;
		try {
			this.#socket.send(JSON.stringify(frame));
		} catch {
			// A close can race with the final response. There is no safe frame to send.
		}
	}

	#receive(data: string): void {
		let frame: ToolHostFrame;
		try {
			frame = parseToolHostFrame(data);
		} catch {
			return;
		}
		if (frame.type === "call_tool") void this.#call(frame);
		if (frame.type === "cancel_tool") this.#cancel(frame.requestId, frame.sessionId);
	}

	async #call(frame: Extract<ToolHostFrame, { type: "call_tool" }>): Promise<void> {
		const session = this.#session;
		const getToolByName = session?.toolSession.getToolByName;
		if (this.#sessionId !== frame.sessionId) return;
		if (session === undefined || getToolByName === undefined) {
			this.#sendError(frame.requestId, "session_unavailable", "Tool host session unavailable.");
			return;
		}
		const tool = getToolByName(frame.toolName);
		const registered = this.#registeredTools.some(entry => entry.name === frame.toolName);
		if (tool === undefined || !registered) {
			this.#sendError(frame.requestId, "tool_denied", "Tool is not available.");
			return;
		}
		const controller = new AbortController();
		const pending: PendingCall = {
			requestId: frame.requestId,
			controller,
			timer: setTimeout(
				() => this.#settlePending(frame.requestId, "approval_timeout", "Tool approval timed out."),
				Math.max(1, this.#config?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
			),
		};
		this.#pending.set(frame.requestId, pending);
		try {
			const result = await tool.execute(
				`prime-bridge:${this.#sessionId}:${frame.requestId}`,
				frame.arguments,
				controller.signal,
				(_partial: AgentToolResult) => undefined,
				session.getToolContext(),
			);
			if (this.#pending.get(frame.requestId) !== pending || pending.reason !== undefined) return;
			clearTimeout(pending.timer);
			this.#pending.delete(frame.requestId);
			this.#send({ type: "tool_result", requestId: frame.requestId, result });
		} catch (error) {
			if (this.#pending.get(frame.requestId) !== pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(frame.requestId);
			const code = errorCode(error);
			this.#sendError(frame.requestId, code, errorPublicMessage(code));
		}
	}

	#cancel(requestId: string, sessionId: string): void {
		if (sessionId !== this.#sessionId) return;
		this.#settlePending(requestId, "tool_canceled", "Tool call canceled.");
	}

	#settlePending(requestId: string, reason: PendingCall["reason"], message: string): void {
		const pending = this.#pending.get(requestId);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.#pending.delete(requestId);
		pending.reason = reason;
		pending.controller.abort(reason);
		const code = reason ?? "tool_execution_failed";
		this.#sendError(requestId, code, message);
	}

	#abortPending(reason: "disconnected"): void {
		for (const requestId of this.#pending.keys()) this.#settlePending(requestId, reason, "Tool host disconnected.");
	}

	#sendError(requestId: string, code: string, message: string): void {
		this.#send({ type: "tool_error", requestId, code, message });
	}
}
